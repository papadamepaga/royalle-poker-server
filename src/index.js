import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { customAlphabet } from "nanoid";
import { PokerTable, maxPlayersForVariant } from "./pokerEngine.js";
import { migrate } from "./db.js";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.js";
import {
  AVATAR_OPTIONS, createUser, findUserByUsername, findUserById,
  createClub, getClubByCode, addMember, getMember, listMembers, listClubsForUser,
  adjustMemberChips, adjustClubTreasury, recordRake, getWeeklyRake, getTotalRake, getTotalPlatformRake,
  getOrCreateQuickWallet, adjustQuickWalletChips, claimDailyBonus,
  updateUserAvatar, getUserStats, recordHandStat,
  updateUserAvatarImage, renameUser, updateClubImage, updateClubCoverImage,
  listClubTables, createClubTable, getClubTableById, updateClubTable, deleteClubTable,
  recordPayLedger, getPayHistory,
  createJoinRequest, hasJoinRequest, listJoinRequests, removeJoinRequest,
  createAnnouncement, getLatestAnnouncement, listAnnouncements,
  createNotification, listNotifications, deleteNotification, deleteAllNotifications,
  recordHandLedger, getCareerEntries,
  setMemberNickname, setMemberNote, touchLastSeen, getMemberCareerEntries,
  createTournament, listClubTournaments, listActiveTournaments, getTournamentById, updateTournament,
  listTournamentEntries, getTournamentEntry, addTournamentEntry, removeTournamentEntry, updateTournamentEntry,
} from "./store.js";
import { MAX_SEATS, makeBotId, pickBotName, pickBotAction } from "./bots.js";

const PORT = process.env.PORT || 3001;
const makeCode = customAlphabet("0123456789", 6);
const makeQuickCode = customAlphabet("0123456789", 8);

// Mesas públicas de "Jogar" (fora de clube) — matchmaking automático por
// tipo de jogo E nível de blind (o jogador escolhe os dois, nunca uma mesa
// específica). Só Hold'em está habilitado por enquanto; PLO4/5/6 usam o
// mesmo motor mas com regras de mão/aposta que ainda não implementamos.
// Os 4 níveis de blind são os mesmos para todos os tipos de jogo.
const STAKES_TIERS = [
  { smallBlind: 100, bigBlind: 200, buyIn: 1000 },
  { smallBlind: 500, bigBlind: 1000, buyIn: 5000 },
  { smallBlind: 1000, bigBlind: 2000, buyIn: 10000 },
  { smallBlind: 5000, bigBlind: 10000, buyIn: 50000 },
];
const QUICK_VARIANTS = {
  holdem: { label: "Texas Hold'em", enabled: true },
  plo4: { label: "4-Card PLO", enabled: true },
  plo5: { label: "5-Card PLO", enabled: true },
  plo6: { label: "6-Card PLO", enabled: true },
};

const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));

// Endpoint simples pra publicar avisos (ex: notas de atualização) sem
// precisar de painel administrativo. Protegido por uma chave — defina
// ADMIN_KEY nas variáveis de ambiente do Render antes de usar.
// Exemplo de uso (troque a URL e a chave):
//   curl -X POST https://royalle-poker-server.onrender.com/admin/announcements \
//     -H "Content-Type: application/json" -H "x-admin-key: SUA_CHAVE" \
//     -d '{"version":"1.7353","title":"Versão 1.7353","body":"- Melhoria 1\n- Melhoria 2"}'
app.post("/admin/announcements", async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
    return res.status(403).json({ ok: false, error: "Não autorizado." });
  }
  const { version, title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ ok: false, error: "title e body são obrigatórios." });
  const announcement = await createAnnouncement({ version, title, body });
  res.json({ ok: true, announcement });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---- Runtime (in-memory, per-club live state) -------------------------
// Persistent stuff (users, club metadata, chip balances) lives in
// Postgres via store.js. This map only holds what's inherently transient:
// the live PokerTable instance and which sockets are currently watching
// or seated at a given club.
const runtime = new Map(); // code -> { clubId, sockets: Set<ws>, socketToPlayer: Map<ws, username>, table: PokerTable|null }

function ensureRuntime(code, clubId) {
  if (!runtime.has(code)) runtime.set(code, { clubId, clubCode: code, sockets: new Set(), socketToPlayer: new Map(), table: null });
  return runtime.get(code);
}

// ============================================================
// TORNEIOS (MTT)
// ============================================================
// REGRAS DO TORNEIO — resumo:
// 1. Inscrição: fica aberta desde a criação até o horário marcado (e
//    continua aceitando gente por mais `late_reg_minutes` depois que já
//    começou — "late registration"). O buy-in sai do saldo do jogador
//    no clube e vai pra tesouraria do clube (mesmo mecanismo já validado
//    de enviar/retirar fichas — nunca cria fichas do nada).
// 2. Início automático: quando bate o horário marcado, se tiver gente
//    suficiente (min_players), o torneio começa: todo mundo recebe a
//    mesma pilha inicial (starting_chips) e é distribuído em mesas de
//    até 9 lugares. Se não tiver gente suficiente, é cancelado e todo
//    mundo recebe o buy-in de volta.
// 3. Blind: sobe de nível automaticamente a cada `level_minutes`,
//    seguindo uma progressão geométrica calculada a partir da pilha
//    inicial (sempre ~100 blinds grandes de profundidade no nível 1,
//    subindo ~30% por nível) — não depende de tabela fixa, funciona pra
//    qualquer buy-in/pilha configurados.
// 4. Eliminação: quando as fichas de um jogador chegam a zero, ele é
//    eliminado e recebe uma colocação (quanto mais cedo sai, pior a
//    colocação). O torneio termina quando sobra 1 jogador.
// 5. Premiação: o total arrecadado (buy-ins, com garantia mínima de GTD
//    coberta pela tesouraria do clube se precisar) é dividido entre os
//    melhores colocados numa curva decrescente clássica (~12% dos
//    inscritos são premiados; 1º lugar leva a maior fatia).
// LIMITAÇÃO CONHECIDA (documentada, não escondida): com mais de 9
// inscritos, o torneio roda em várias mesas, mas ainda não há
// rebalanceamento automático de jogadores entre mesas durante o jogo —
// cada mesa toca sozinha até esvaziar. Rebalanceamento fica pra uma
// próxima etapa.

const BLIND_SPEED_MINUTES = { slow: 15, standard: 10, turbo: 5, hyperturbo: 3 };

// Formata um torneio (linha crua do banco) pro formato que o cliente
// entende — camelCase, com contagens já calculadas, e o status da
// inscrição de quem está pedindo (se já tiver uma).
function publicTournament(t, entries, myEntry) {
  const active = entries.filter((e) => e.status !== "cancelled");
  return {
    id: t.id, name: t.name, variant: t.variant, buyIn: Number(t.buy_in),
    startingChips: Number(t.starting_chips), maxPlayers: t.max_players, minPlayers: t.min_players,
    blindStructure: t.blind_structure, levelMinutes: t.level_minutes, lateRegMinutes: t.late_reg_minutes,
    rebuyAllowed: t.rebuy_allowed, rebuyMax: t.rebuy_max, gtdPrize: Number(t.gtd_prize),
    startTime: t.start_time, status: t.status, currentLevel: t.current_level,
    levelStartedAt: t.level_started_at, finishedAt: t.finished_at,
    entryCount: active.length,
    playersLeft: active.filter((e) => e.status === "playing" || e.status === "registered").length,
    myStatus: myEntry ? myEntry.status : null,
  };
}

function tournamentBlindLevel(startingChips, levelIndex) {
  const n = Math.max(0, levelIndex);
  const baseBB = Math.max(20, Math.round(startingChips / 100 / 10) * 10);
  const bb = Math.round((baseBB * Math.pow(1.3, n)) / 10) * 10;
  const sb = Math.max(5, Math.round(bb / 2 / 5) * 5);
  return { sb, bb };
}

function tournamentTableCode(clubCode, tournamentId, tableIndex) {
  return `${clubCode}#T${tournamentId}-${tableIndex}`;
}

// Curva de pagamento: ~12% dos inscritos são premiados (mínimo 1), com
// pesos decrescentes clássicos (cada posição leva 62% do que a de cima
// levou), normalizados pra somar exatamente o total do prêmio.
function tournamentPayoutFractions(numEntries) {
  const paid = Math.max(1, Math.round(numEntries * 0.12) || 1);
  const weights = Array.from({ length: paid }, (_, i) => Math.pow(0.62, i));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

async function refundTournamentEntry(t, entry) {
  await adjustMemberChips(t.club_id, entry.user_id, Number(entry.chips));
  await adjustClubTreasury(t.club_id, -Number(entry.chips));
}

async function startTournament(t) {
  const allEntries = await listTournamentEntries(t.id);
  const active = allEntries.filter((e) => e.status === "registered");
  if (active.length < t.min_players) {
    for (const e of active) {
      await refundTournamentEntry(t, e);
      await updateTournamentEntry(t.id, e.user_id, { status: "cancelled" });
    }
    await updateTournament(t.id, { status: "cancelled" });
    return;
  }
  const numTables = Math.max(1, Math.ceil(active.length / 9));
  const tables = Array.from({ length: numTables }, () => new PokerTable({ smallBlind: 0, bigBlind: 0, rakePercent: 0, variant: t.variant }));
  active.forEach((e, i) => tables[i % numTables].addPlayer(e.username, e.username, Number(e.chips), false));
  const level = tournamentBlindLevel(t.starting_chips, 0);
  for (const table of tables) { table.smallBlind = level.sb; table.bigBlind = level.bb; }
  tables.forEach((table, idx) => {
    const code = tournamentTableCode(t.club_code, t.id, idx);
    const rt = ensureRuntime(code, t.club_id);
    rt.table = table;
    rt.isTournament = true;
    rt.tournamentId = t.id;
    rt.pendingLeave = new Set();
  });
  for (const e of active) await updateTournamentEntry(t.id, e.user_id, { status: "playing" });
  await updateTournament(t.id, { status: "running", currentLevel: 0, levelStartedAt: new Date().toISOString() });
  tables.forEach((table, idx) => {
    table.startHand();
    broadcastTable(tournamentTableCode(t.club_code, t.id, idx));
  });
}

async function finishTournament(t) {
  const entries = await listTournamentEntries(t.id);
  const stillIn = entries.filter((e) => e.status === "playing");
  // Quem sobrou (deveria ser só 1) fecha em 1º lugar.
  for (const e of stillIn) await updateTournamentEntry(t.id, e.user_id, { status: "eliminated", rank: 1, eliminatedAt: new Date().toISOString() });
  const finalEntries = await listTournamentEntries(t.id);
  const paidEntries = finalEntries.filter((e) => e.rank != null).sort((a, b) => a.rank - b.rank);
  const totalBuyIns = finalEntries.filter((e) => e.status !== "cancelled").reduce((s, e) => s + Number(t.buy_in), 0);
  const prizePool = Math.max(Number(t.gtd_prize) || 0, totalBuyIns);
  const fractions = tournamentPayoutFractions(finalEntries.filter((e) => e.status !== "cancelled").length);
  for (let i = 0; i < fractions.length && i < paidEntries.length; i++) {
    const prize = Math.round(prizePool * fractions[i]);
    if (prize <= 0) continue;
    await adjustMemberChips(t.club_id, paidEntries[i].user_id, prize);
    // O prêmio SAI da tesouraria do clube (o dinheiro dos buy-ins + a
    // garantia, se precisar cobrir diferença, já estão lá) — tinha um
    // bug aqui que fazia a tesouraria AUMENTAR ao pagar prêmio, criando
    // ficha do nada. Tem que ser negativo, igual toda vez que o clube
    // manda fichas pra um jogador (adjust_chips, refund, etc.).
    await adjustClubTreasury(t.club_id, -prize);
    await updateTournamentEntry(t.id, paidEntries[i].user_id, { prize });
  }
  await updateTournament(t.id, { status: "finished", finishedAt: new Date().toISOString() });
  // Limpa os runtimes das mesas desse torneio.
  for (const [code, rt] of runtime.entries()) {
    if (rt.tournamentId === t.id) runtime.delete(code);
  }
}

// Toca uma mesa de torneio sozinha: inicia a próxima mão, marca quem
// zerou como eliminado (com a colocação certa) e verifica se o torneio
// já deve terminar. Chamado depois de cada broadcastTable de uma mesa
// marcada como isTournament.
async function pulseTournamentTable(code) {
  const rt = runtime.get(code);
  if (!rt?.isTournament || !rt.table) return;
  const table = rt.table;
  if (table.stage !== "showdown" && table.stage !== "idle") return;
  // Evita agendar o mesmo processamento várias vezes seguidas — cada
  // broadcastTable durante o showdown chamaria essa função de novo antes
  // do setTimeout anterior disparar, o que faria startHand() rodar mais
  // de uma vez pra mesma mão.
  if (rt.pulseScheduled) return;
  const t = await getTournamentById(rt.tournamentId);
  if (!t || t.status !== "running") return;
  rt.pulseScheduled = true;

  setTimeout(async () => {
    rt.pulseScheduled = false;
    if (runtime.get(code)?.table !== table) return;
    // Sincroniza fichas atuais de quem jogou essa mão com a linha do
    // torneio, e marca eliminado quem zerou.
    const stillPlaying = (await listTournamentEntries(t.id)).filter((e) => e.status === "playing");
    for (const p of table.players) {
      if (p.chips > 0) { await updateTournamentEntry(t.id, p.id, { chips: p.chips }); continue; }
      const remaining = stillPlaying.length; // quantos ainda restavam de verdade nesse instante
      await updateTournamentEntry(t.id, p.id, { status: "eliminated", chips: 0, rank: remaining, eliminatedAt: new Date().toISOString() });
    }
    table.players = table.players.filter((p) => p.chips > 0);

    const nowActive = (await listTournamentEntries(t.id)).filter((e) => e.status === "playing");
    if (nowActive.length <= 1) { await finishTournament(t); return; }

    if (table.players.length >= 2) {
      table.startHand();
      broadcastTable(code);
    }
  }, table.stage === "showdown" ? 4000 : 300);
}

// Roda a cada 15s: sobe o nível de blind de torneios em andamento cujo
// tempo do nível atual já passou, e inicia torneios agendados cujo
// horário já chegou.
async function tickTournaments() {
  const now = Date.now();
  let active;
  try {
    active = await listActiveTournaments();
  } catch (err) {
    console.error("Erro ao listar torneios ativos:", err.message);
    return;
  }
  for (const t of active) {
    try {
      if (t.status === "scheduled") {
        if (new Date(t.start_time).getTime() <= now) await startTournament(t);
        continue;
      }
      if (t.status === "running") {
        const levelMs = Number(t.level_minutes) * 60 * 1000;
        const startedAt = t.level_started_at ? new Date(t.level_started_at).getTime() : now;
        if (now - startedAt < levelMs) continue;
        const nextLevel = Number(t.current_level) + 1;
        const blinds = tournamentBlindLevel(t.starting_chips, nextLevel);
        let tableIdx = 0;
        for (const [code, rt] of runtime.entries()) {
          if (rt.tournamentId !== t.id || !rt.table) continue;
          rt.table.smallBlind = blinds.sb;
          rt.table.bigBlind = blinds.bb;
          broadcastTable(code);
          tableIdx++;
        }
        await updateTournament(t.id, { currentLevel: nextLevel, levelStartedAt: new Date().toISOString() });
      }
    } catch (err) {
      console.error(`Erro processando torneio #${t.id}:`, err.message);
    }
  }
}

function ensureQuickRuntime(code, variant, tierIndex) {
  if (!runtime.has(code)) {
    runtime.set(code, { clubId: null, isQuick: true, variant, tierIndex, sockets: new Set(), socketToPlayer: new Map(), table: null });
  }
  return runtime.get(code);
}

// Acha uma mesa pública dessa variante + nível de blind com vaga (de
// verdade vazia, ou ocupada por um bot que pode ser trocado por um
// jogador real). Prioriza mesas que já estão rolando em vez de criar uma
// nova. O limite de assentos respeita a variante — PLO com mais cartas
// por jogador cabe menos gente na mesma mesa (baralho de 52 cartas).
function findOpenQuickTable(variant, tierIndex) {
  const seatCap = Math.min(MAX_SEATS, maxPlayersForVariant(variant));
  let botFallback = null;
  for (const [code, rt] of runtime.entries()) {
    if (!rt.isQuick || rt.variant !== variant || rt.tierIndex !== tierIndex || !rt.table) continue;
    const seated = rt.table.players.length;
    if (seated < seatCap) return { code, rt, botIdToReplace: null };
    const bot = rt.table.players.find((p) => p.isBot);
    if (bot && !botFallback) botFallback = { code, rt, botIdToReplace: bot.id };
  }
  return botFallback;
}

function fillWithBots(table, upTo) {
  const cap = upTo ?? Math.min(MAX_SEATS, maxPlayersForVariant(table.variant));
  const names = table.players.map((p) => p.name);
  while (table.players.length < cap) {
    const name = pickBotName(names);
    names.push(name);
    table.addPlayer(makeBotId(), name, table.bigBlind * 100, true);
  }
}

// Mantém a mesa viva sozinha: inicia a próxima mão automaticamente e faz
// os bots jogarem a vez deles, sem precisar de nenhum clique do jogador.
// Só se aplica a mesas públicas (isQuick) — mesas de clube continuam
// exatamente como estavam, com o botão manual de "iniciar mão".
function pulseQuickTable(code) {
  const rt = runtime.get(code);
  if (!rt || !rt.isQuick || !rt.table) return;
  const table = rt.table;

  if (table.stage === "idle") {
    const funded = table.players.filter((p) => p.chips > 0).length;
    if (funded >= 2) {
      setTimeout(() => {
        if (runtime.get(code)?.table !== table || table.stage !== "idle") return;
        table.startHand();
        broadcastTable(code);
      }, 1200);
    }
    return;
  }

  if (table.stage === "showdown") {
    setTimeout(async () => {
      if (runtime.get(code)?.table !== table || table.stage !== "showdown") return;
      // Estatísticas: cada jogador real que participou dessa mão (não bot)
      // conta uma mão jogada, e vitória se aparece nos resultados.
      for (const p of table.players) {
        if (p.isBot || !p.inHand) continue;
        const user = await findUserByUsername(p.id);
        if (user) recordHandStat(user.id, !!table.results[p.id]);
      }
      // Some embora quem ficou sem fichas e sem jogadores reais restando —
      // evita mesa de bots jogando sozinha pra sempre depois que todo
      // mundo saiu.
      const hasReal = table.players.some((p) => !p.isBot);
      if (!hasReal) { runtime.delete(code); return; }
      table.players = table.players.filter((p) => p.chips > 0 || !p.isBot);
      if (table.players.filter((p) => p.chips > 0).length < 2) fillWithBots(table);
      table.startHand();
      broadcastTable(code);
    }, 4000);
    return;
  }

  const actingBot = table.players.find((p) => p.id === table.actingId && p.isBot);
  if (actingBot && rt._scheduledBotFor !== actingBot.id) {
    rt._scheduledBotFor = actingBot.id;
    setTimeout(() => {
      rt._scheduledBotFor = null;
      if (runtime.get(code)?.table !== table || table.actingId !== actingBot.id) return;
      const decision = pickBotAction(table, actingBot.id);
      const result = table.applyAction(actingBot.id, decision.action, decision.amount);
      // Rede de segurança: se por algum motivo a ação calculada for
      // rejeitada (nunca deveria acontecer, mas apostar demais em "nunca"
      // é como se trava uma mesa pra sempre), o bot desiste em vez de
      // ficar preso esperando a própria vez indefinidamente.
      if (result?.error) table.applyAction(actingBot.id, "fold");
      broadcastTable(code);
    }, 700 + Math.random() * 900);
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

async function broadcastClub(code) {
  const rt = runtime.get(code);
  if (!rt) return;
  const club = await getClubByCode(code);
  const members = await listMembers(rt.clubId);
  const totalRake = await getTotalRake(rt.clubId);
  const platformRake = await getTotalPlatformRake(rt.clubId);
  for (const ws of rt.sockets) {
    const viewerIsOwner = members.find((m) => m.username === ws.username)?.role === "owner" || members.find((m) => m.username === ws.username)?.role === "agent";
    send(ws, {
      type: "club_state",
      club: publicClub(club, viewerIsOwner, { totalRake, platformRake }),
      members: membersForViewer(members, ws.username, viewerIsOwner),
    });
  }
}

// Depois de cada mão terminar (idle ou showdown), remove quem pediu pra
// sair no meio da mão anterior — tirar alguém no meio do jogo bagunçaria
// o pote e travaria a vez de quem já não existe mais na mesa.
async function sweepPendingLeaves(code) {
  const rt = runtime.get(code);
  if (!rt?.table || !rt.pendingLeave?.size) return;
  if (rt.table.stage !== "idle" && rt.table.stage !== "showdown") return;
  const clubCode = code.includes("#") ? code.split("#")[0] : code;
  for (const { username, userId } of [...rt.pendingLeave]) {
    const player = rt.table.players.find((p) => p.id === username);
    if (player) {
      if (rt.isQuick) await adjustQuickWalletChips(userId, player.chips);
      else await adjustMemberChips(rt.clubId, userId, player.chips);
      rt.table.removePlayer(username);
    }
  }
  resetIfEmpty(rt);
  rt.pendingLeave.clear();
  if (!rt.isQuick) await broadcastClub(clubCode);
  broadcastTable(code);
}

function broadcastTable(code) {
  const rt = runtime.get(code);
  const table = rt?.table;
  if (!table) return;
  for (const [ws, username] of rt.socketToPlayer.entries()) {
    send(ws, { type: "table_state", state: table.getPublicState(username) });
  }
  maybeRecordRake(rt);
  maybeRecordHandLedger(rt, code);
  if (table.needsAutoRunout()) {
    // Quando todo mundo já está all-in (ninguém mais decide nada), as
    // cartas saem bem mais devagar — dá tempo de ver a mão revelada e a %
    // de vitória antes da próxima carta, em vez de tudo bater junto.
    const delay = table.allInRunout ? 2800 : 900;
    setTimeout(() => {
      if (rt.table !== table) return;
      table.advanceStage();
      broadcastTable(code);
    }, delay);
  }
  if (rt.isQuick) pulseQuickTable(code);
  if (rt.isTournament) pulseTournamentTable(code);
  sweepPendingLeaves(code);
}

async function maybeRecordRake(rt) {
  const clubAmount = rt.table?.pendingRake || 0;
  const platformAmount = rt.table?.pendingPlatformRake || 0;
  if (clubAmount > 0 || platformAmount > 0) {
    rt.table.pendingRake = 0;
    rt.table.pendingPlatformRake = 0;
    if (rt.clubId) await recordRake(rt.clubId, clubAmount, platformAmount);
    // O dono precisa ver o rake do clube E o rake do app atualizarem na
    // hora, sem precisar sair e entrar de novo no clube.
    if (rt.clubCode) await broadcastClub(rt.clubCode);
  }
}

// Carreira: só mesas de CLUBE contam (fichas fictícias de "Jogar" fora de
// clube nunca entram aqui). Guarda o ganho/perda de cada jogador logo
// depois que a mão termina, e zera lastHandDeltas pra não gravar de novo
// nos próximos broadcasts dessa mesma mão.
async function maybeRecordHandLedger(rt, code) {
  const deltas = rt.table?.lastHandDeltas;
  if (!deltas || rt.isQuick || !rt.clubId) { if (deltas) rt.table.lastHandDeltas = null; return; }
  rt.table.lastHandDeltas = null;
  const tableId = code.includes("#") ? Number(code.split("#")[1]) : null;
  for (const [playerId, delta] of Object.entries(deltas)) {
    const user = await findUserByUsername(playerId);
    if (user) await recordHandLedger(rt.clubId, tableId, user.id, delta);
  }
}

// Mesa de clube (não a de "Jogar") esvaziou de gente de verdade — limpa a
// mão/mesa antiga por completo, pra não deixar cartas/pote de uma mão
// anterior visíveis quando alguém sentar de novo depois.
function resetIfEmpty(rt) {
  if (!rt.isQuick && rt.table && rt.table.players.length === 0) {
    rt.table = null;
  }
}

function publicClub(club, viewerIsOwner, extra = {}) {
  if (!club) return null;
  const base = {
    id: club.id,
    code: club.code,
    name: club.name,
    image: club.image || null,
    coverImage: club.cover_image || null,
    smallBlind: club.small_blind,
    bigBlind: club.big_blind,
    buyIn: club.buy_in,
    rakePercent: Number(club.rake_percent),
    ownerId: club.owner_id,
  };
  // Tesouraria e rake acumulado são informação administrativa — só o
  // dono/admin recebe esses campos. Pra membro comum, nem chegam a existir
  // no payload (não é só esconder na interface).
  if (viewerIsOwner) {
    return { ...base, treasuryChips: Number(club.treasury_chips), totalRake: extra.totalRake ?? 0, platformRake: extra.platformRake ?? 0 };
  }
  return base;
}

// Cada membro vê a lista de membros de forma diferente: o dono/admin vê o
// saldo de todo mundo; um membro comum só vê o próprio saldo — o dos outros
// vem sem o campo "chips".
function membersForViewer(members, viewerUsername, viewerIsOwner) {
  if (viewerIsOwner) return members;
  return members.map((m) => (m.username === viewerUsername ? m : { username: m.username, avatar: m.avatar, avatar_image: m.avatar_image, role: m.role }));
}

function requireAuth(ws, ctx) {
  if (!ws.userId) { ctx.reply({ ok: false, error: "Faça login primeiro." }); return false; }
  return true;
}

async function handleMessage(ws, msg, ctx) {
  const { type } = msg;

  if (type === "signup") {
    const username = (msg.username || "").trim();
    const password = msg.password || "";
    const avatar = AVATAR_OPTIONS.includes(msg.avatar) ? msg.avatar : AVATAR_OPTIONS[0];
    if (username.length < 3) return ctx.reply({ ok: false, error: "Usuário precisa ter pelo menos 3 letras." });
    if (password.length < 4) return ctx.reply({ ok: false, error: "Senha precisa ter pelo menos 4 caracteres." });
    const existing = await findUserByUsername(username);
    if (existing) return ctx.reply({ ok: false, error: "Esse nome de usuário já existe." });
    const hash = await hashPassword(password);
    const user = await createUser(username, hash, avatar);
    if (!user) return ctx.reply({ ok: false, error: "Não deu pra criar a conta." });
    ws.userId = user.id; ws.username = user.username;
    await touchLastSeen(user.id);
    const token = signToken(user.id, user.username);
    ctx.reply({ ok: true, token, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: null } });
    return;
  }

  if (type === "login") {
    const username = (msg.username || "").trim();
    const user = await findUserByUsername(username);
    if (!user) return ctx.reply({ ok: false, error: "Usuário ou senha incorretos." });
    const valid = await verifyPassword(msg.password || "", user.password_hash);
    if (!valid) return ctx.reply({ ok: false, error: "Usuário ou senha incorretos." });
    ws.userId = user.id; ws.username = user.username;
    await touchLastSeen(user.id);
    const token = signToken(user.id, user.username);
    ctx.reply({ ok: true, token, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: user.avatar_image || null } });
    return;
  }

  if (type === "authenticate") {
    const payload = verifyToken(msg.token || "");
    if (!payload) return ctx.reply({ ok: false, error: "Sessão expirada, faça login de novo." });
    const user = await findUserById(payload.sub);
    if (!user) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    ws.userId = user.id; ws.username = user.username;
    await touchLastSeen(user.id);
    ctx.reply({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: user.avatar_image || null } });
    return;
  }

  if (type === "create_club") {
    if (!requireAuth(ws, ctx)) return;
    // ID do clube — só números, do mesmo jeito que o ID pessoal do
    // jogador. Tenta algumas vezes só pra garantir que não bateu num
    // já existente (chance bem baixa, mas com só dígitos é maior que
    // antes com letras+números).
    let code = makeCode();
    for (let i = 0; i < 5 && (await getClubByCode(code)); i++) code = makeCode();
    const club = await createClub({
      code,
      name: msg.clubName,
      ownerId: ws.userId,
      smallBlind: msg.smallBlind || 25,
      bigBlind: msg.bigBlind || 50,
      buyIn: msg.buyIn || 5000,
      rakePercent: msg.rakePercent ?? 5,
    });
    await addMember(club.id, ws.userId, 0, "owner");
    const rt = ensureRuntime(code, club.id);
    rt.sockets.add(ws);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
    await createNotification(ws.userId, club.id, "Bem-vindo ao Royalle!",
      `Caro jogador:\nVocê criou um clube. Tenha uma ótima experiência no poker!`);
    return;
  }

  if (type === "join_club") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Código não encontrado." });
    const existing = await getMember(club.id, ws.userId);
    if (existing) {
      const rt = ensureRuntime(club.code, club.id);
      rt.sockets.add(ws);
      ctx.setJoinedCode(club.code);
      ctx.reply({ ok: true, code: club.code, clubName: club.name });
      await broadcastClub(club.code);
      return;
    }
    // Ainda não é membro — vira uma solicitação, o dono precisa aprovar
    // antes de dar acesso de verdade ao clube.
    await createJoinRequest(club.id, ws.userId);
    ctx.reply({ ok: true, pending: true });
    return;
  }

  if (type === "list_join_requests") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const requests = await listJoinRequests(club.id);
    ctx.reply({ ok: true, requests: requests.map((r) => ({ username: r.username, avatar: r.avatar, avatar_image: r.avatar_image })) });
    return;
  }

  if (type === "approve_join_request") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    const ok = await hasJoinRequest(club.id, target.id);
    if (!ok) return ctx.reply({ ok: false, error: "Solicitação não encontrada." });
    await addMember(club.id, target.id, 0, "member");
    await removeJoinRequest(club.id, target.id);
    ctx.reply({ ok: true });
    return;
  }

  if (type === "reject_join_request") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    await removeJoinRequest(club.id, target.id);
    ctx.reply({ ok: true });
    return;
  }

  if (type === "get_club_state") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const members = await listMembers(club.id);
    const rt = ensureRuntime(club.code, club.id);
    rt.sockets.add(ws);
    ctx.setJoinedCode(club.code);
    const me = members.find((m) => m.username === ws.username);
    const viewerIsOwner = me?.role === "owner" || me?.role === "agent";
    const weeklyRake = viewerIsOwner ? await getWeeklyRake(club.id) : 0;
    const totalRake = viewerIsOwner ? await getTotalRake(club.id) : 0;
    const platformRake = viewerIsOwner ? await getTotalPlatformRake(club.id) : 0;
    ctx.reply({
      ok: true,
      club: publicClub(club, viewerIsOwner, { totalRake, platformRake }),
      members: membersForViewer(members, ws.username, viewerIsOwner),
      weeklyRake,
    });
    if (rt.table) send(ws, { type: "table_state", state: rt.table.getPublicState(ws.username) });
    return;
  }

  if (type === "adjust_chips") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    const delta = Number(msg.delta);
    const before = await getMember(club.id, target.id);
    const balanceBefore = before ? Number(before.chips) : 0;
    // Enviar (delta > 0): sai da tesouraria do clube, entra pro jogador —
    // não pode passar do que a tesouraria realmente tem.
    // Retirar (delta < 0): sai do jogador, volta pra tesouraria do clube —
    // não pode passar do que o jogador realmente tem. Sem essa checagem,
    // "retirar" de um jogador com saldo zerado inflava a tesouraria do
    // clube com fichas que nunca existiram de verdade.
    if (delta > 0 && Number(club.treasury_chips) < delta) {
      return ctx.reply({ ok: false, error: "Saldo do clube insuficiente." });
    }
    if (delta < 0 && balanceBefore < -delta) {
      return ctx.reply({ ok: false, error: "Esse jogador não tem fichas suficientes pra essa retirada." });
    }
    const chips = await adjustMemberChips(club.id, target.id, delta);
    const treasuryChips = await adjustClubTreasury(club.id, -delta);
    await recordPayLedger({
      clubId: club.id, userId: target.id, adminId: ws.userId,
      type: delta >= 0 ? "send" : "withdraw",
      amount: Math.abs(delta), balanceBefore, balanceAfter: Number(chips),
    });
    ctx.reply({ ok: true, chips, treasuryChips });
    await broadcastClub(club.code);
    if (delta > 0) {
      await createNotification(target.id, club.id, "Fichas Recebidas!",
        `"${ws.username}" (ID: ${ws.userId}) enviou ${Math.abs(delta).toLocaleString("pt-BR")} fichas para você.`);
    } else if (delta < 0) {
      await createNotification(target.id, club.id, "Fichas Retiradas",
        `"${ws.username}" (ID: ${ws.userId}) retirou ${Math.abs(delta).toLocaleString("pt-BR")} fichas de você.`);
    }
    return;
  }

  if (type === "get_pay_history") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false });
    const me = await getMember(club.id, ws.userId);
    if (!me) return ctx.reply({ ok: false, error: "Sem permissão." });
    const isPrivileged = me.role === "owner" || me.role === "agent";
    let targetId = null;
    if (msg.targetUsername) {
      // Membro comum só pode pedir o PRÓPRIO histórico — nunca o de outra
      // pessoa. Dono/agente pode pedir de qualquer um (ou de todos, sem
      // targetUsername).
      if (!isPrivileged && msg.targetUsername !== ws.username) return ctx.reply({ ok: false, error: "Sem permissão." });
      const target = await findUserByUsername(msg.targetUsername);
      if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
      targetId = target.id;
    } else if (!isPrivileged) {
      // Sem targetUsername e sem ser dono/agente: assume que é o próprio
      // histórico (é o único que teria permissão de ver).
      targetId = ws.userId;
    }
    const history = await getPayHistory(club.id, targetId);
    ctx.reply({
      ok: true,
      history: history.map((h) => ({
        username: h.username, admin: h.admin_username, type: h.type,
        amount: Number(h.amount), balanceBefore: Number(h.balance_before), balanceAfter: Number(h.balance_after),
        createdAt: h.created_at,
      })),
    });
    return;
  }

  if (type === "set_member_nickname" || type === "set_member_note") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    if (type === "set_member_nickname") await setMemberNickname(club.id, target.id, msg.value);
    else await setMemberNote(club.id, target.id, msg.value);
    ctx.reply({ ok: true });
    await broadcastClub(club.code);
    return;
  }

  if (type === "get_member_career") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    const entries = await getMemberCareerEntries(club.id, target.id);
    ctx.reply({ ok: true, entries });
    return;
  }

  // Mesas configuráveis dentro de um clube (Royalle Pay). Um clube pode ter
  // várias, cada uma com seu próprio tipo de jogo/blinds/rake/buy-in — cria
  // uma mesa padrão automaticamente na primeira consulta de clubes antigos
  // que ainda não tinham nenhuma (migração transparente).
  async function ensureDefaultClubTable(club) {
    const existing = await listClubTables(club.id);
    if (existing.length > 0) return existing;
    const t = await createClubTable({
      clubId: club.id, variant: "holdem",
      smallBlind: club.small_blind, bigBlind: club.big_blind,
      buyIn: club.buy_in, rakePercent: Number(club.rake_percent), maxPlayers: MAX_SEATS,
    });
    return [t];
  }

  if (type === "list_club_tables") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const tables = await ensureDefaultClubTable(club);
    ctx.reply({
      ok: true,
      tables: tables.map((t) => ({
        id: t.id, variant: t.variant, smallBlind: t.small_blind, bigBlind: t.big_blind,
        buyIn: t.buy_in, rakePercent: Number(t.rake_percent), maxPlayers: t.max_players,
        playersNow: runtime.get(`${club.code}#${t.id}`)?.table?.players?.length || 0,
      })),
    });
    return;
  }

  if (type === "create_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const variant = msg.variant;
    if (!QUICK_VARIANTS[variant]) return ctx.reply({ ok: false, error: "Tipo de jogo inválido." });
    const smallBlind = Number(msg.smallBlind), bigBlind = Number(msg.bigBlind), buyIn = Number(msg.buyIn);
    const rakePercent = Math.min(10, Math.max(1, Number(msg.rakePercent) || 5));
    const maxPlayers = Math.min(maxPlayersForVariant(variant), Math.max(2, Number(msg.maxPlayers) || 9));
    if (!(smallBlind > 0) || !(bigBlind > smallBlind) || !(buyIn > 0)) {
      return ctx.reply({ ok: false, error: "Blinds/buy-in inválidos." });
    }
    await ensureDefaultClubTable(club); // garante migração antes de adicionar mais uma
    const t = await createClubTable({ clubId: club.id, variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers });
    ctx.reply({ ok: true, tableId: t.id });
    return;
  }

  if (type === "update_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const existing = await getClubTableById(club.id, Number(msg.tableId));
    if (!existing) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const variant = msg.variant;
    if (!QUICK_VARIANTS[variant]) return ctx.reply({ ok: false, error: "Tipo de jogo inválido." });
    const smallBlind = Number(msg.smallBlind), bigBlind = Number(msg.bigBlind), buyIn = Number(msg.buyIn);
    const rakePercent = Math.min(10, Math.max(1, Number(msg.rakePercent) || 5));
    const maxPlayers = Math.min(maxPlayersForVariant(variant), Math.max(2, Number(msg.maxPlayers) || 9));
    if (!(smallBlind > 0) || !(bigBlind > smallBlind) || !(buyIn > 0)) {
      return ctx.reply({ ok: false, error: "Blinds/buy-in inválidos." });
    }
    const runtimeCode = `${club.code}#${existing.id}`;
    if (runtime.get(runtimeCode)?.table?.players?.length > 0) {
      return ctx.reply({ ok: false, error: "Não dá pra editar uma mesa com jogadores sentados." });
    }
    await updateClubTable(club.id, existing.id, { variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers });
    ctx.reply({ ok: true });
    return;
  }

  if (type === "delete_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const existing = await getClubTableById(club.id, Number(msg.tableId));
    if (!existing) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const runtimeCode = `${club.code}#${existing.id}`;
    if (runtime.get(runtimeCode)?.table?.players?.length > 0) {
      return ctx.reply({ ok: false, error: "Não dá pra apagar uma mesa com jogadores sentados." });
    }
    await deleteClubTable(club.id, existing.id);
    runtime.delete(runtimeCode);
    ctx.reply({ ok: true });
    return;
  }

  if (type === "list_club_tournaments") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const list = await listClubTournaments(club.id);
    const withCounts = await Promise.all(list.map(async (t) => {
      const entries = await listTournamentEntries(t.id);
      const mine = entries.find((e) => e.user_id === ws.userId);
      return publicTournament(t, entries, mine);
    }));
    ctx.reply({ ok: true, tournaments: withCounts });
    return;
  }

  if (type === "create_tournament") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const variant = msg.variant;
    if (!QUICK_VARIANTS[variant]) return ctx.reply({ ok: false, error: "Tipo de jogo inválido." });
    if (!BLIND_SPEED_MINUTES[msg.blindStructure]) return ctx.reply({ ok: false, error: "Estrutura de blind inválida." });
    const name = String(msg.name || "").trim().slice(0, 60) || "Torneio sem nome";
    const buyIn = Math.max(0, Number(msg.buyIn) || 0);
    const startingChips = Math.max(100, Number(msg.startingChips) || 10000);
    const maxPlayers = Math.min(90, Math.max(2, Number(msg.maxPlayers) || 90));
    const minPlayers = Math.min(maxPlayers, Math.max(2, Number(msg.minPlayers) || 2));
    const lateRegMinutes = Math.max(0, Number(msg.lateRegMinutes) || 0);
    const rebuyAllowed = !!msg.rebuyAllowed;
    const rebuyMax = rebuyAllowed ? Math.max(1, Number(msg.rebuyMax) || 1) : 0;
    const gtdPrize = Math.max(0, Number(msg.gtdPrize) || 0);
    // A garantia (GTD) tem que sair de algum lugar se os buy-ins não
    // cobrirem o valor prometido — é a tesouraria do clube que cobre essa
    // diferença. Não faz sentido prometer uma garantia maior do que o
    // clube realmente tem guardado, senão o torneio promete um prêmio
    // que não existe.
    if (gtdPrize > Number(club.treasury_chips)) {
      return ctx.reply({ ok: false, error: `A garantia não pode passar do saldo do clube (${Number(club.treasury_chips).toLocaleString("pt-BR")}).` });
    }
    const startTime = new Date(msg.startTime);
    if (isNaN(startTime.getTime()) || startTime.getTime() < Date.now() - 60000) {
      return ctx.reply({ ok: false, error: "Horário de início inválido (precisa ser no futuro)." });
    }
    const t = await createTournament({
      clubId: club.id, name, variant, buyIn, startingChips, maxPlayers, minPlayers,
      blindStructure: msg.blindStructure, levelMinutes: BLIND_SPEED_MINUTES[msg.blindStructure],
      lateRegMinutes, rebuyAllowed, rebuyMax, gtdPrize, startTime: startTime.toISOString(), createdBy: ws.userId,
    });
    ctx.reply({ ok: true, tournamentId: t.id });
    return;
  }

  if (type === "get_tournament") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    const entries = await listTournamentEntries(t.id);
    const mine = entries.find((e) => e.user_id === ws.userId);
    ctx.reply({
      ok: true,
      tournament: publicTournament(t, entries, mine),
      entries: entries
        .slice()
        .sort((a, b) => (a.rank || 999) - (b.rank || 999) || new Date(a.registered_at) - new Date(b.registered_at))
        .map((e) => ({
          username: e.username, avatar: e.avatar, avatar_image: e.avatar_image,
          status: e.status, chips: Number(e.chips), rank: e.rank, prize: Number(e.prize || 0),
        })),
    });
    return;
  }

  // O torneio já está rodando (startTournament já sentou o jogador numa
  // PokerTable de verdade, programaticamente) — esse comando é o que
  // liga o WEBSOCKET desse jogador àquela mesa, exatamente como
  // sit_club_table faz pras mesas normais. Sem isso, o jogador nunca
  // conseguia ver/jogar a mesa mesmo estando tecnicamente inscrito e
  // com fichas em jogo — era só um número no banco, sem lobby de verdade.
  if (type === "join_tournament_table") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    if (t.status !== "running") return ctx.reply({ ok: false, error: "Esse torneio ainda não começou." });
    let foundCode = null;
    for (const [code, rt] of runtime.entries()) {
      if (rt.tournamentId === t.id && rt.table?.players?.some((p) => p.id === ws.username)) { foundCode = code; break; }
    }
    if (!foundCode) return ctx.reply({ ok: false, error: "Você não está numa mesa desse torneio (foi eliminado ou não chegou a se inscrever a tempo)." });
    const rt = runtime.get(foundCode);
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(foundCode);
    ctx.reply({ ok: true, code: foundCode });
    broadcastTable(foundCode);
    return;
  }

  if (type === "register_tournament") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    if (t.status !== "scheduled" && t.status !== "running") return ctx.reply({ ok: false, error: "Esse torneio não está aceitando inscrições." });
    if (t.status === "running") {
      const startedRunningAt = t.level_started_at ? new Date(t.level_started_at).getTime() : Date.now();
      // Aproximação razoável: inscrição tardia conta a partir do início
      // do torneio, não do nível atual — usamos created_at como início.
      const tournamentStartedAt = new Date(t.start_time).getTime();
      if (Date.now() > tournamentStartedAt + Number(t.late_reg_minutes) * 60000) {
        return ctx.reply({ ok: false, error: "Inscrição tardia já encerrou." });
      }
    }
    const existing = await getTournamentEntry(t.id, ws.userId);
    if (existing) return ctx.reply({ ok: false, error: "Você já está inscrito nesse torneio." });
    const entries = await listTournamentEntries(t.id);
    const activeCount = entries.filter((e) => e.status !== "cancelled").length;
    if (activeCount >= t.max_players) return ctx.reply({ ok: false, error: "Torneio lotado." });
    const member = await getMember(t.club_id, ws.userId);
    if (!member || Number(member.chips) < Number(t.buy_in)) return ctx.reply({ ok: false, error: "Saldo insuficiente pra esse buy-in." });
    await adjustMemberChips(t.club_id, ws.userId, -Number(t.buy_in));
    await adjustClubTreasury(t.club_id, Number(t.buy_in));
    await addTournamentEntry(t.id, ws.userId, Number(t.starting_chips));
    ctx.reply({ ok: true });
    return;
  }

  if (type === "unregister_tournament") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    if (t.status !== "scheduled") return ctx.reply({ ok: false, error: "Só dá pra cancelar a inscrição antes do torneio começar." });
    const existing = await getTournamentEntry(t.id, ws.userId);
    if (!existing) return ctx.reply({ ok: false, error: "Você não está inscrito nesse torneio." });
    await adjustMemberChips(t.club_id, ws.userId, Number(existing.chips));
    await adjustClubTreasury(t.club_id, -Number(existing.chips));
    await removeTournamentEntry(t.id, ws.userId);
    ctx.reply({ ok: true });
    return;
  }

  if (type === "cancel_tournament") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    const me = await getMember(t.club_id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    if (t.status !== "scheduled") return ctx.reply({ ok: false, error: "Só dá pra cancelar um torneio que ainda não começou." });
    const entries = await listTournamentEntries(t.id);
    for (const e of entries) {
      if (e.status === "cancelled") continue;
      await adjustMemberChips(t.club_id, e.user_id, Number(e.chips));
      await adjustClubTreasury(t.club_id, -Number(e.chips));
      await updateTournamentEntry(t.id, e.user_id, { status: "cancelled" });
    }
    await updateTournament(t.id, { status: "cancelled" });
    ctx.reply({ ok: true });
    return;
  }

  if (type === "sit_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const t = await getClubTableById(club.id, Number(msg.tableId));
    if (!t) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const member = await getMember(club.id, ws.userId);
    const minBuyIn = t.buy_in;
    const maxBuyIn = t.buy_in * 4;
    if (!member || Number(member.chips) < minBuyIn) return ctx.reply({ ok: false, error: "Royalle Pay insuficiente." });
    const buyIn = Math.min(maxBuyIn, Math.max(minBuyIn, Number(msg.buyIn) || minBuyIn), Number(member.chips));
    await adjustMemberChips(club.id, ws.userId, -buyIn);
    const code = `${club.code}#${t.id}`;
    const rt = ensureQuickRuntime(code, t.variant, null);
    rt.isQuick = false; // usa carteira de clube (Royalle Pay), não a avulsa
    rt.clubId = club.id;
    rt.clubCode = club.code;
    if (!rt.table) rt.table = new PokerTable({ smallBlind: t.small_blind, bigBlind: t.big_blind, rakePercent: Number(t.rake_percent), variant: t.variant });
    rt.table.addPlayer(ws.username, ws.username, buyIn, false);
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
    broadcastTable(code);
    return;
  }

  if (type === "sit_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const member = await getMember(club.id, ws.userId);
    if (!member || member.chips < msg.buyIn) return ctx.reply({ ok: false, error: "Fichas insuficientes." });
    await adjustMemberChips(club.id, ws.userId, -msg.buyIn);
    const rt = ensureRuntime(club.code, club.id);
    if (!rt.table) rt.table = new PokerTable({ smallBlind: club.small_blind, bigBlind: club.big_blind, rakePercent: Number(club.rake_percent) });
    rt.table.addPlayer(ws.username, ws.username, msg.buyIn);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.reply({ ok: true });
    await broadcastClub(club.code);
    broadcastTable(club.code);
    return;
  }

  if (type === "start_hand") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: false });
    if (rt.table.stage !== "idle" && rt.table.stage !== "showdown") return ctx.reply({ ok: false, error: "Já tem uma mão em andamento." });
    rt.table.startHand();
    ctx.reply({ ok: true });
    broadcastTable(code);
    return;
  }

  if (type === "get_profile") {
    if (!requireAuth(ws, ctx)) return;
    const wallet = await getOrCreateQuickWallet(ws.userId);
    const stats = await getUserStats(ws.userId);
    const today = new Date().toISOString().slice(0, 10);
    const lastClaim = wallet.lastDailyClaim ? new Date(wallet.lastDailyClaim).toISOString().slice(0, 10) : null;
    ctx.reply({
      ok: true,
      chips: wallet.chips,
      gems: wallet.gems,
      canClaimDaily: lastClaim !== today,
      stats: { handsPlayed: Number(stats.hands_played), handsWon: Number(stats.hands_won) },
    });
    return;
  }

  if (type === "list_notifications") {
    if (!requireAuth(ws, ctx)) return;
    const notifications = await listNotifications(ws.userId);
    return ctx.reply({ ok: true, notifications });
  }

  if (type === "delete_notification") {
    if (!requireAuth(ws, ctx)) return;
    await deleteNotification(Number(msg.id), ws.userId);
    return ctx.reply({ ok: true });
  }

  if (type === "clear_notifications") {
    if (!requireAuth(ws, ctx)) return;
    await deleteAllNotifications(ws.userId);
    return ctx.reply({ ok: true });
  }

  if (type === "get_latest_announcement") {
    if (!requireAuth(ws, ctx)) return;
    const announcement = await getLatestAnnouncement();
    return ctx.reply({ ok: true, announcement });
  }

  if (type === "list_announcements") {
    if (!requireAuth(ws, ctx)) return;
    const announcements = await listAnnouncements();
    return ctx.reply({ ok: true, announcements });
  }

  if (type === "get_career") {
    if (!requireAuth(ws, ctx)) return;
    const entries = await getCareerEntries(ws.userId);
    return ctx.reply({ ok: true, entries });
  }

  if (type === "get_my_clubs") {
    if (!requireAuth(ws, ctx)) return;
    const clubs = await listClubsForUser(ws.userId);
    // Quantas mesas o clube tem abertas de verdade (multi-mesa), não só
    // quem tá sentado numa mesa específica agora.
    const withCounts = await Promise.all(clubs.map(async (c) => ({ ...c, openTables: (await listClubTables(c.id)).length })));
    ctx.reply({ ok: true, clubs: withCounts });
    return;
  }

  if (type === "update_avatar") {
    if (!requireAuth(ws, ctx)) return;
    if (!AVATAR_OPTIONS.includes(msg.avatar)) return ctx.reply({ ok: false, error: "Avatar inválido." });
    await updateUserAvatar(ws.userId, msg.avatar);
    ws.username && (ws.avatar = msg.avatar);
    ctx.reply({ ok: true, avatar: msg.avatar });
    return;
  }

  // Editar o próprio perfil — nome e/ou foto enviada do dispositivo.
  // Os dois campos são opcionais e independentes (manda só o que mudou).
  if (type === "update_profile") {
    if (!requireAuth(ws, ctx)) return;
    let newUsername = ws.username;
    if (typeof msg.username === "string" && msg.username.trim() && msg.username.trim() !== ws.username) {
      const trimmed = msg.username.trim();
      if (trimmed.length < 3 || trimmed.length > 20) return ctx.reply({ ok: false, error: "O nome precisa ter entre 3 e 20 caracteres." });
      if (!/^[a-zA-Z0-9_ ]+$/.test(trimmed)) return ctx.reply({ ok: false, error: "Use só letras, números, espaço e _." });
      const renamed = await renameUser(ws.userId, trimmed);
      if (!renamed.ok) return ctx.reply({ ok: false, error: renamed.error });
      newUsername = trimmed;
    }
    if (msg.avatarImage !== undefined) {
      // Limite generoso (~1.4MB em base64, a imagem já vem comprimida do
      // cliente) só pra evitar abuso — não é o tamanho normal esperado.
      if (msg.avatarImage !== null && (typeof msg.avatarImage !== "string" || msg.avatarImage.length > 1_900_000)) {
        return ctx.reply({ ok: false, error: "Imagem inválida ou grande demais." });
      }
      await updateUserAvatarImage(ws.userId, msg.avatarImage);
    }
    ws.username = newUsername;
    ctx.reply({ ok: true, username: newUsername, avatarImage: msg.avatarImage !== undefined ? msg.avatarImage : undefined });
    // Atualiza o nome/foto em tempo real pra quem tiver esse jogador na
    // lista de membros de algum clube em comum.
    const myClubs = await listClubsForUser(ws.userId);
    for (const c of myClubs) await broadcastClub(c.code);
    return;
  }

  // Foto/logo do clube — só o dono/agente pode trocar.
  if (type === "update_club_image") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    if (msg.image !== null && (typeof msg.image !== "string" || msg.image.length > 1_900_000)) {
      return ctx.reply({ ok: false, error: "Imagem inválida ou grande demais." });
    }
    await updateClubImage(club.id, msg.image);
    ctx.reply({ ok: true });
    await broadcastClub(club.code);
    return;
  }

  // Capa do cabeçalho do clube (banner) — mesma regra de permissão que o
  // logo. O valor pode ser um preset do app (base64 já embutido no
  // frontend) ou uma foto enviada do dispositivo do dono.
  if (type === "update_club_cover") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    if (msg.image !== null && (typeof msg.image !== "string" || msg.image.length > 1_900_000)) {
      return ctx.reply({ ok: false, error: "Imagem inválida ou grande demais." });
    }
    await updateClubCoverImage(club.id, msg.image);
    ctx.reply({ ok: true });
    await broadcastClub(club.code);
    return;
  }

  if (type === "find_table") {
    if (!requireAuth(ws, ctx)) return;
    const variant = msg.variant;
    const cfg = QUICK_VARIANTS[variant];
    if (!cfg) return ctx.reply({ ok: false, error: "Tipo de jogo inválido." });
    if (!cfg.enabled) return ctx.reply({ ok: false, error: "Esse formato chega em breve." });
    const tierIndex = Number(msg.stakesTier);
    const tier = STAKES_TIERS[tierIndex];
    if (!tier) return ctx.reply({ ok: false, error: "Nível de blind inválido." });

    const wallet = await getOrCreateQuickWallet(ws.userId);
    const minBuyIn = tier.buyIn;
    const maxBuyIn = tier.buyIn * 4; // convenção comum de mesa de cash: até 4x o buy-in mínimo
    if (wallet.chips < minBuyIn) return ctx.reply({ ok: false, error: "Royalle Coins insuficientes pra esse nível." });
    const buyIn = Math.min(maxBuyIn, Math.max(minBuyIn, Number(msg.buyIn) || minBuyIn), wallet.chips);

    let found = findOpenQuickTable(variant, tierIndex);
    let code, rt;
    if (found) {
      ({ code, rt } = found);
      if (found.botIdToReplace) rt.table.removePlayer(found.botIdToReplace);
    } else {
      code = makeQuickCode();
      rt = ensureQuickRuntime(code, variant, tierIndex);
      rt.table = new PokerTable({ smallBlind: tier.smallBlind, bigBlind: tier.bigBlind, rakePercent: 0, variant });
    }

    await adjustQuickWalletChips(ws.userId, -buyIn);
    rt.table.addPlayer(ws.username, ws.username, buyIn, false);
    if (!found) fillWithBots(rt.table);
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code, variant });
    broadcastTable(code);
    return;
  }

  if (type === "claim_daily_bonus") {
    if (!requireAuth(ws, ctx)) return;
    const res = await claimDailyBonus(ws.userId);
    ctx.reply({ ok: true, claimed: res.claimed, chips: res.chips });
    return;
  }

  if (type === "player_action") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const username = rt.socketToPlayer.get(ws);
    if (!username) return ctx.reply({ ok: false, error: "Você não está sentado." });
    const result = rt.table.applyAction(username, msg.action, msg.amount);
    broadcastTable(code);
    ctx.reply(result?.error ? { ok: false, error: result.error } : { ok: true });
    return;
  }

  if (type === "rebuy") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const username = rt.socketToPlayer.get(ws);
    const player = rt.table.players.find((p) => p.id === username);
    if (!player) return ctx.reply({ ok: false, error: "Você não está sentado." });
    // Só dá pra comprar mais fichas entre mãos — no meio de uma mão em
    // andamento bagunçaria o pote e as apostas já feitas.
    if (rt.table.stage !== "idle" && rt.table.stage !== "showdown") {
      return ctx.reply({ ok: false, error: "Espere a mão atual terminar pra comprar mais fichas." });
    }
    const amount = Math.floor(Number(msg.amount));
    if (!amount || amount <= 0) return ctx.reply({ ok: false, error: "Valor inválido." });

    if (rt.isQuick) {
      const wallet = await getOrCreateQuickWallet(ws.userId);
      if (Number(wallet.chips) < amount) return ctx.reply({ ok: false, error: "Royalle Coin insuficiente." });
      await adjustQuickWalletChips(ws.userId, -amount);
    } else {
      const clubCode = code.includes("#") ? code.split("#")[0] : code;
      const club = await getClubByCode(clubCode);
      if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
      const member = await getMember(club.id, ws.userId);
      if (!member || Number(member.chips) < amount) return ctx.reply({ ok: false, error: "Royalle Pay insuficiente." });
      await adjustMemberChips(club.id, ws.userId, -amount);
    }
    player.chips += amount;
    ctx.reply({ ok: true, chips: player.chips });
    broadcastTable(code);
    if (!rt.isQuick && rt.clubCode) await broadcastClub(rt.clubCode);
    return;
  }

  if (type === "leave_table") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: true });
    const username = rt.socketToPlayer.get(ws);
    const player = rt.table.players.find((p) => p.id === username);

    // Mão em andamento e o jogador ainda está nela: não dá pra tirar da
    // mesa agora sem bagunçar o pote (ele já apostou fichas nessa mão).
    // Marca "sair assim que a mão terminar" — ele continua jogando essa
    // mão normalmente, mas é removido e recebe as fichas de volta assim
    // que ela acabar, sem precisar de outro clique.
    const midHand = rt.table.stage !== "idle" && rt.table.stage !== "showdown";
    if (player && midHand && player.inHand && !player.folded) {
      rt.pendingLeave = rt.pendingLeave || new Set();
      let already = false;
      for (const e of rt.pendingLeave) if (e.username === username) already = true;
      if (!already) rt.pendingLeave.add({ username, userId: ws.userId });
      ctx.reply({ ok: true, pending: true });
      return;
    }

    if (rt.isQuick) {
      let chips = 0;
      if (player) {
        chips = await adjustQuickWalletChips(ws.userId, player.chips);
        rt.table.removePlayer(username);
      }
      rt.socketToPlayer.delete(ws);
      rt.sockets.delete(ws);
      const stillReal = rt.table.players.some((p) => !p.isBot);
      if (!stillReal) runtime.delete(code);
      ctx.reply({ ok: true, chips });
      if (runtime.has(code)) broadcastTable(code);
      return;
    }

    const clubCode = code.includes("#") ? code.split("#")[0] : code;
    const club = await getClubByCode(clubCode);
    let chips = 0;
    if (player && club) {
      chips = await adjustMemberChips(club.id, ws.userId, player.chips);
      rt.table.removePlayer(username);
    }
    resetIfEmpty(rt);
    rt.socketToPlayer.delete(ws);
    ctx.reply({ ok: true, chips });
    await broadcastClub(clubCode);
    broadcastTable(code);
    return;
  }

  console.warn("Tipo de mensagem desconhecido:", type);
  ctx.reply({ ok: false, error: `Tipo de mensagem desconhecido: ${type}` });
}

wss.on("connection", (ws) => {
  console.log("Nova conexão WebSocket recebida.");
  let joinedCode = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Mensagem inválida (não é JSON):", raw.toString());
      return;
    }
    console.log("Mensagem recebida:", msg.type, JSON.stringify(msg).slice(0, 200));
    const reply = (data) => send(ws, { type: "ack", reqId: msg.reqId, ...data });

    try {
      await handleMessage(ws, msg, { reply, setJoinedCode: (c) => { joinedCode = c; } });
    } catch (err) {
      console.error("Erro processando mensagem", msg.type, err);
      reply({ ok: false, error: "Erro interno no servidor." });
    }
  });

  ws.on("close", () => {
    console.log("Conexão WebSocket fechada.");
    if (!joinedCode) return;
    const rt = runtime.get(joinedCode);
    if (!rt) return;
    const username = rt.socketToPlayer.get(ws);
    if (username && rt.table) {
      const p = rt.table.players.find((pl) => pl.id === username);
      if (p) p.connected = false;
      broadcastTable(joinedCode);
    }
    rt.sockets.delete(ws);
    rt.socketToPlayer.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("Erro no WebSocket:", err.message);
  });
});

migrate()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Royalle Poker server rodando na porta ${PORT}`);
    });
    // Relógio dos torneios — confere a cada 15s se algum precisa começar
    // sozinho (chegou a hora) ou subir de nível de blind.
    setInterval(() => { tickTournaments(); }, 15000);
  })
  .catch((err) => {
    console.error("Falha ao migrar banco de dados:", err);
    process.exit(1);
  });
