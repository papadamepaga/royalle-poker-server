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
  listClubTables, createClubTable, getClubTableById, updateClubTable, deleteClubTable,
  recordPayLedger, getPayHistory,
  createJoinRequest, hasJoinRequest, listJoinRequests, removeJoinRequest,
  createAnnouncement, getLatestAnnouncement, listAnnouncements,
  createNotification, listNotifications, deleteNotification, deleteAllNotifications,
  recordHandLedger, getCareerEntries,
  setMemberNickname, setMemberNote, touchLastSeen, getMemberCareerEntries,
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
  return members.map((m) => (m.username === viewerUsername ? m : { username: m.username, avatar: m.avatar, role: m.role }));
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
    ctx.reply({ ok: true, token, user: { id: user.id, username: user.username, avatar: user.avatar } });
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
    ctx.reply({ ok: true, token, user: { id: user.id, username: user.username, avatar: user.avatar } });
    return;
  }

  if (type === "authenticate") {
    const payload = verifyToken(msg.token || "");
    if (!payload) return ctx.reply({ ok: false, error: "Sessão expirada, faça login de novo." });
    const user = await findUserById(payload.sub);
    if (!user) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    ws.userId = user.id; ws.username = user.username;
    await touchLastSeen(user.id);
    ctx.reply({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar } });
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
    ctx.reply({ ok: true, requests: requests.map((r) => ({ username: r.username, avatar: r.avatar })) });
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
    // Enviar (delta > 0): sai da tesouraria do clube, entra pro jogador.
    // Retirar (delta < 0): sai do jogador, volta pra tesouraria do clube.
    if (delta > 0 && Number(club.treasury_chips) < delta) {
      return ctx.reply({ ok: false, error: "Saldo do clube insuficiente." });
    }
    const before = await getMember(club.id, target.id);
    const balanceBefore = before ? Number(before.chips) : 0;
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
  })
  .catch((err) => {
    console.error("Falha ao migrar banco de dados:", err);
    process.exit(1);
  });
