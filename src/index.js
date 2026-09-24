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
  createClub, getClubByCode, getClubById, addMember, getMember, listMembers, listClubsForUser,
  adjustMemberChips, adjustClubTreasury, recordRake, getWeeklyRake, getTotalRake, getTotalPlatformRake,
  setJackpotConfig, addJackpotChips,
  createAgentWallet, getAgentWallet, getAgentWalletById, listAgentWallets, setAgentStatus,
  setCommissionRate, getCurrentCommissionRate, listCommissionRateHistory,
  setRakebackRate, getCurrentRakebackRate, listRakebackRateHistory,
  linkMemberToAgent, getCurrentAgentLink, listAgentLinkHistory, listAgentMembers,
  recordRakeEvent, getRakeSummary, getAgentRakeTable, getMemberRakeTable,
  closeRakePeriod, listRakeClosings, getRakeClosingDetail, getAgentWalletSummary,
  getOrCreateQuickWallet, adjustQuickWalletChips, adjustQuickWalletGems, claimDailyBonus,
  updateUserAvatar, getUserStats, recordHandStat,
  updateUserAvatarImage, renameUser, setNickname, updateClubImage, updateClubCoverImage, setClubLevel, setMemberRole,
  listClubTables, createClubTable, getClubTableById, updateClubTable, deleteClubTable, getTablePlayerStats, bumpTablePlayerStats,
  recordPayLedger, getPayHistory,
  createJoinRequest, hasJoinRequest, listJoinRequests, removeJoinRequest, getJoinRequestAgent,
  createAnnouncement, getLatestAnnouncement, listAnnouncements,
  createNotification, listNotifications, deleteNotification, deleteAllNotifications,
  recordHandLedger, getCareerEntries,
  setMemberNickname, setMemberNote, touchLastSeen, getMemberCareerEntries,
  createTournament, listClubTournaments, listActiveTournaments, getTournamentById, updateTournament,
  listTournamentEntries, getTournamentEntry, addTournamentEntry, removeTournamentEntry, updateTournamentEntry,
  getUserPlatformRole, listAllClubsForMaster, getClubForMasterDetail, setClubStatus,
  listAllUsersForMaster, getUserForMasterDetail, setUserStatus,
  listDiamondPackages, createDiamondPackage, updateDiamondPackage, creditDiamondsWithLedger, listDiamondTransactions,
  getActiveCommercialCondition, listCommercialConditionHistory, setClubCommercialCondition,
  listClubLevelConfigs, setClubLevelConfig,
  recordAdminAuditLog, listAdminAuditLogs, getPlatformFinancialSummary,
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
// Restrição de GPS/IP em torneio: como as mesas são geradas na hora que
// o MTT começa (não dá pra checar "quem já tá sentado nessa mesa" igual
// mesa cash), a checagem acontece na INSCRIÇÃO, contra os outros
// inscritos no torneio inteiro — tournamentId -> [{ userId, ip, lat, lng }].
// Fica só em memória (perde num restart do servidor), o suficiente pra
// coibir múltiplas contas da mesma pessoa/lugar num torneio ao vivo.
const tournamentRegCoords = new Map();
// Registro autorizado: fila de pedidos aguardando o dono/gestor aprovar
// — tournamentId -> [{ userId, username, avatar, requestedAt }].
const tournamentPendingRegs = new Map();
// Registro global de quem está online agora (username -> ws), pra poder
// empurrar avisos pra alguém mesmo fora do contexto de uma mesa/clube
// específico — como "seu torneio começou, você está na mesa X".
const onlineByUsername = new Map();
function pushToUser(username, msg) {
  const ws = onlineByUsername.get(username);
  if (ws && ws.readyState === ws.OPEN) send(ws, msg);
}

function ensureRuntime(code, clubId) {
  if (!runtime.has(code)) runtime.set(code, { clubId, clubCode: code, sockets: new Set(), socketToPlayer: new Map(), table: null });
  return runtime.get(code);
}

// Registra (ou soma, se já tinha entrado antes nessa mesma sessão de
// mesa) o buy-in de um jogador no "resultado em tempo real" da mesa —
// usado tanto no sentar quanto na recompra.
function recordSessionBuyIn(table, username, amount) {
  if (!table) return;
  table.sessionStats = table.sessionStats || {};
  const existing = table.sessionStats[username];
  if (existing) existing.buyIn += amount;
  else table.sessionStats[username] = { name: username, buyIn: amount, finalChips: null };
}
// Congela o resultado de quem está saindo da mesa de vez — sem isso,
// depois que o jogador sai (removePlayer), não teria mais como saber
// com quantas fichas ele ficou, e o histórico "some" a linha dele.
function freezeSessionResult(table, username, finalChips) {
  if (!table?.sessionStats?.[username]) return;
  table.sessionStats[username].finalChips = finalChips;
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

// Estruturas de blind — igual ao dropdown "Estrut. de blinds" do
// pppoker (Padrão/Turbo/Deep Stack/Especial/Hiperturbo/High Roller).
// Cada uma só muda a DURAÇÃO do nível e a VELOCIDADE de crescimento do
// blind (growth = multiplicador do BB a cada nível); a fórmula de valor
// em si é a mesma (tournamentBlindLevel). Simplificação assumida: não
// reproduz a tabela oficial nível-a-nível do pppoker (essa é enorme e
// varia por buy-in) — pra ter os valores exatos, use "Personalizar" na
// criação do torneio, que grava uma tabela fixa (custom_blind_levels) e
// passa a valer no lugar dessa fórmula.
const BLIND_STRUCTURES = {
  standard: { label: "Padrão", levelMinutes: 10, growth: 1.30 },
  turbo: { label: "Turbo", levelMinutes: 5, growth: 1.30 },
  deep_stack: { label: "Deep Stack", levelMinutes: 12, growth: 1.22 },
  special: { label: "Especial", levelMinutes: 8, growth: 1.28 },
  hyperturbo: { label: "Hiperturbo", levelMinutes: 3, growth: 1.35 },
  high_roller: { label: "High Roller", levelMinutes: 15, growth: 1.25 },
};

// Níveis de clube (Clube Nível, igual PPPoker) — cada um vale 30 dias e
// dá mais capacidade de membros/gestores. Nível 0 é o padrão gratuito
// (sem compra), com uma capacidade bem enxuta.
// Valor inicial = mesmo de sempre (fallback caso o banco ainda não
// tenha semeado club_level_configs) — mas isso agora é só o ponto de
// partida: reloadClubLevelTiers() troca pelo que estiver configurado
// no Royalle Master, sem precisar reiniciar o servidor pra pegar uma
// mudança de preço/limite de nível.
let CLUB_LEVEL_TIERS = {
  0: { gestor: 1, membro: 10, price: 0 },
  1: { gestor: 3, membro: 60, price: 1500 },
  2: { gestor: 4, membro: 100, price: 2500 },
  3: { gestor: 5, membro: 150, price: 4000 },
  4: { gestor: 6, membro: 250, price: 8000 },
  5: { gestor: 10, membro: 600, price: 20000 },
  6: { gestor: 12, membro: 800, price: 30000 },
  7: { gestor: 15, membro: 1200, price: 45000 },
  8: { gestor: 20, membro: 1500, price: 60000 },
  9: { gestor: 25, membro: 1800, price: 80000 },
  10: { gestor: 50, membro: 2500, price: 110000 },
};
async function reloadClubLevelTiers() {
  const rows = await listClubLevelConfigs();
  if (!rows.length) return;
  const next = {};
  rows.forEach((r) => { next[r.level] = { gestor: r.gestor_cap, membro: r.membro_cap, price: Number(r.price_diamonds) }; });
  CLUB_LEVEL_TIERS = next;
}
// Nível "de verdade" agora — se a validade (30 dias) já passou, volta
// pro nível 0 na prática, mesmo que o banco ainda tenha o número antigo
// guardado (evita precisar de um relógio de fundo só pra isso).
function effectiveClubLevel(club) {
  const expired = !club.level_expires_at || new Date(club.level_expires_at).getTime() < Date.now();
  const level = expired ? 0 : Number(club.level || 0);
  return { level, ...CLUB_LEVEL_TIERS[level] };
}

// Formata um torneio (linha crua do banco) pro formato que o cliente
// entende — camelCase, com contagens já calculadas, e o status da
// inscrição de quem está pedindo (se já tiver uma).
function publicTournament(t, entries, myEntry, myUsername) {
  const active = entries.filter((e) => e.status !== "cancelled");
  const totalBuyIns = active.reduce((s, e) => s + Number(e.buy_in_paid ?? t.buy_in), 0);
  const totalBountyPaid = entries.reduce((s, e) => s + Number(e.bounty_won || 0), 0);
  const estimatedPool = Math.max(Number(t.gtd_prize) || 0, totalBuyIns - totalBountyPaid);
  const itmBase = tournamentItmBaseCount(active, t.itm_mode || "buyins");
  const fractions = tournamentPayoutFractions(itmBase, Number(t.payout_percent) || 12, t.payout_weighting || "standard");
  const payoutTable = fractions.map((f, i) => ({ rank: i + 1, prize: Math.round(estimatedPool * f) }));
  // Mesas ainda em jogo desse torneio, pra aba "Mesas" — não depende de
  // nada além de vasculhar o runtime, já que cada mesa de torneio guarda
  // o próprio tournamentId. De passagem já acha em qual mesa o jogador
  // que está perguntando está sentado agora, pra dar o botão de "entrar
  // na minha mesa" sem ele precisar ficar procurando.
  const tables = [];
  let myTableCode = null;
  for (const [code, rt] of runtime.entries()) {
    if (rt.tournamentId === t.id && rt.table) {
      tables.push({ code, playersLeft: rt.table.players.length, avgStack: rt.table.players.length ? Math.round(rt.table.players.reduce((s, p) => s + p.chips, 0) / rt.table.players.length) : 0 });
      if (myUsername && rt.table.players.some((p) => p.name === myUsername)) myTableCode = code;
    }
  }
  return {
    id: t.id, name: t.name, variant: t.variant, buyIn: Number(t.buy_in),
    startingChips: Number(t.starting_chips), maxPlayers: t.max_players, minPlayers: t.min_players,
    blindStructure: t.blind_structure, levelMinutes: t.level_minutes, lateRegMinutes: t.late_reg_minutes,
    rebuyAllowed: t.rebuy_allowed, rebuyMax: t.rebuy_max, gtdPrize: Number(t.gtd_prize),
    startTime: t.start_time, status: t.status, currentLevel: t.current_level,
    levelStartedAt: t.level_started_at, finishedAt: t.finished_at,
    earlyBirdDiscountPct: t.early_bird_discount_pct, earlyBirdDeadline: t.early_bird_deadline,
    earlyBirdActive: !!(t.early_bird_deadline && Date.now() < new Date(t.early_bird_deadline).getTime()),
    earlyBirdChipBonusPct: t.early_bird_chip_bonus_pct, earlyBirdChipBonusLevel: t.early_bird_chip_bonus_level,
    bountyEnabled: t.bounty_enabled, bountyPercent: t.bounty_percent, payoutPercent: Number(t.payout_percent),
    koMode: t.ko_mode, itmMode: t.itm_mode, payoutWeighting: t.payout_weighting,
    rebuyMultiplier: Number(t.rebuy_multiplier), rebuyDouble: !!t.rebuy_double, rebuyTriple: !!t.rebuy_triple,
    addonEnabled: !!t.addon_enabled, addonMultiplier: Number(t.addon_multiplier), addonDouble: !!t.addon_double,
    addonTriple: !!t.addon_triple, addonPauseMinutes: t.addon_pause_minutes,
    lateRegLevel: t.late_reg_level, customBlindLevels: t.custom_blind_levels || null,
    advancedFlags: t.advanced_flags || {}, mysteryPool: Number(t.mystery_pool || 0),
    entryCount: active.length,
    playersLeft: active.filter((e) => e.status === "playing" || e.status === "registered").length,
    myStatus: myEntry ? myEntry.status : null,
    myBuyInPaid: myEntry ? Number(myEntry.buy_in_paid ?? t.buy_in) : null,
    myAddonUsed: myEntry ? !!myEntry.addon_used : false,
    myRebuys: myEntry ? Number(myEntry.rebuys || 0) : 0,
    estimatedPool, payoutTable, tables, myTableCode,
  };
}

// t pode ser a linha crua do torneio (tournaments) ou só um objeto com
// starting_chips/blind_structure/custom_blind_levels — os dois formatos
// batem com o que vem do banco.
function tournamentBlindLevel(t, levelIndex) {
  const n = Math.max(0, levelIndex);
  // "Personalizar>>" — tabela fixa gravada na criação do torneio, tem
  // prioridade sobre a fórmula. Nível além do fim da tabela repete o
  // último nível gravado (igual pppoker).
  const custom = t.custom_blind_levels;
  if (Array.isArray(custom) && custom.length > 0) {
    const lvl = custom[Math.min(n, custom.length - 1)];
    return { sb: Number(lvl.sb) || 0, bb: Number(lvl.bb) || 0, ante: Number(lvl.ante) || 0 };
  }
  const structure = BLIND_STRUCTURES[t.blind_structure] || BLIND_STRUCTURES.standard;
  const startingChips = Number(t.starting_chips) || 10000;
  const baseBB = Math.max(20, Math.round(startingChips / 100 / 10) * 10);
  const bb = Math.round((baseBB * Math.pow(structure.growth, n)) / 10) * 10;
  const sb = Math.max(5, Math.round(bb / 2 / 5) * 5);
  return { sb, bb, ante: 0 };
}

function tournamentTableCode(clubCode, tournamentId, tableIndex) {
  return `${clubCode}#T${tournamentId}-${tableIndex}`;
}

// Fator de decaimento por posição — "Plano" reparte quase igual,
// "Agressivo" concentra bem mais no topo. É o dropdown ao lado do "%"
// na tela de premiação do pppoker.
const PAYOUT_WEIGHT_DECAY = { flat: 0.85, standard: 0.62, aggressive: 0.45 };

// Curva de pagamento: X% da BASE são premiados (mínimo 1), com pesos
// decrescentes normalizados pra somar exatamente o total do prêmio.
// "base" já vem calculada por tournamentItmBaseCount() — pode ser
// contagem de jogadores ou de total de buy-ins, dependendo do
// "Cálculo de ITM" escolhido na criação.
function tournamentPayoutFractions(base, payoutPercent = 12, weighting = "standard") {
  const paid = Math.max(1, Math.round(base * (Number(payoutPercent) / 100)) || 1);
  const decay = PAYOUT_WEIGHT_DECAY[weighting] || PAYOUT_WEIGHT_DECAY.standard;
  const weights = Array.from({ length: paid }, (_, i) => Math.pow(decay, i));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

// "Cálculo de ITM": Jogadores conta só quem entrou (sem contar
// rebuy/add-on de novo); Total de buy-ins conta cada recompra e add-on
// como uma entrada a mais — reflete o texto oficial do pppoker
// ("...calculado com base no número de buy-ins, rebuys e add-ons").
function tournamentItmBaseCount(activeEntries, itmMode) {
  if (itmMode === "players") return activeEntries.length;
  return activeEntries.reduce((s, e) => s + 1 + Number(e.rebuys || 0) + (e.addon_used ? 1 : 0), 0);
}

// K.O. Misterioso: quando o número de jogadores ainda em jogo cai pro
// tamanho da fase ITM, sorteia de uma vez os prêmios que vão ser
// distribuídos daqui pra frente (um por eliminação, até o heads-up) —
// gerados por partição aleatória do pote acumulado (mystery_pool), não
// uniforme, pra ter a variação de "sorte grande vs pequena" que o modo
// promete. Guardado em advanced_flags.mysteryPrizes pra sobreviver um
// restart do servidor. Simplificação assumida: o pppoker sorteia e
// revela ao vivo, aqui o valor só é decidido no instante em que a fase
// ITM é atingida.
function generateMysteryPrizes(pool, count) {
  if (count <= 0 || pool <= 0) return [];
  const cuts = Array.from({ length: count - 1 }, () => Math.random()).sort((a, b) => a - b);
  const bounds = [0, ...cuts, 1];
  const shares = [];
  for (let i = 0; i < count; i++) shares.push(bounds[i + 1] - bounds[i]);
  // Maior fatia sempre embaralhada com as demais (não é sempre a
  // última eliminação que leva o prêmio grande).
  const values = shares.map((s) => Math.round(pool * s));
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

async function refundTournamentEntry(t, entry) {
  // Devolve exatamente o que a pessoa PAGOU de verdade (pode ter sido
  // menos que o buy-in padrão, com desconto Early Bird) — nunca o
  // "chips" (isso é só a pilha de fichas do torneio, não dinheiro real).
  const amount = Number(entry.buy_in_paid ?? entry.chips);
  await adjustMemberChips(t.club_id, entry.user_id, amount);
  await adjustClubTreasury(t.club_id, -amount);
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
  // O torneio (tabela `tournaments`) só guarda club_id, não o código do
  // clube — precisa buscar o clube pra saber o código de verdade, senão
  // o código da mesa vira "undefined#T1-0" e ninguém consegue entrar
  // nela (é exatamente esse o bug que fazia a mesa "não encontrada"
  // quando o jogador tentava agir).
  const club = await getClubById(t.club_id);
  const clubCode = club.code;
  const numTables = Math.max(1, Math.ceil(active.length / 9));
  const tables = Array.from({ length: numTables }, () => new PokerTable({ smallBlind: 0, bigBlind: 0, rakePercent: 0, variant: t.variant }));
  active.forEach((e, i) => tables[i % numTables].addPlayer(e.username, e.username, Number(e.chips), false));
  const level = tournamentBlindLevel(t, 0);
  for (const table of tables) { table.smallBlind = level.sb; table.bigBlind = level.bb; }
  tables.forEach((table, idx) => {
    const code = tournamentTableCode(clubCode, t.id, idx);
    const rt = ensureRuntime(code, t.club_id);
    rt.table = table;
    rt.isTournament = true;
    table.isTournament = true;
    table.tournamentId = t.id;
    table.tournamentBuyIn = Number(t.buy_in);
    table.tournamentStartingChips = Number(t.starting_chips);
    table.tournamentRebuyAllowed = !!t.rebuy_allowed;
    // Opções avançadas do torneio (Banir bate-papo / Ver Cartas
    // Descartadas) — mesmo par de flags que a mesa cash já usa,
    // só que lidas de tournaments.advanced_flags em vez de club_tables.
    const tFlags = t.advanced_flags || {};
    rt.chatBanned = !!tFlags.chatBanned;
    rt.showFoldedCards = tFlags.showFoldedCards !== false;
    rt.tournamentId = t.id;
    rt.pendingLeave = new Set();
  });
  for (const e of active) await updateTournamentEntry(t.id, e.user_id, { status: "playing" });
  await updateTournament(t.id, { status: "running", currentLevel: 0, levelStartedAt: new Date().toISOString() });
  tables.forEach((table, idx) => {
    table.startHand();
    const code = tournamentTableCode(clubCode, t.id, idx);
    broadcastTable(code);
    // Ninguém tem socket "escutando" essa mesa ainda (ela acabou de
    // nascer) — avisa cada jogador direto, onde quer que ele esteja no
    // app agora, pra aparecer o botão de "ir pra mesa" no topo.
    for (const p of table.players) {
      pushToUser(p.id, { type: "table_assigned", code, kind: "tournament", tournamentName: t.name });
    }
  });
}

async function finishTournament(t) {
  const entries = await listTournamentEntries(t.id);
  const stillIn = entries.filter((e) => e.status === "playing");
  // Quem sobrou (deveria ser só 1) fecha em 1º lugar.
  for (const e of stillIn) await updateTournamentEntry(t.id, e.user_id, { status: "eliminated", rank: 1, eliminatedAt: new Date().toISOString() });
  const finalEntries = await listTournamentEntries(t.id);
  const paidEntries = finalEntries.filter((e) => e.rank != null).sort((a, b) => a.rank - b.rank);
  const totalBuyIns = finalEntries.filter((e) => e.status !== "cancelled").reduce((s, e) => s + Number(e.buy_in_paid ?? t.buy_in), 0);
  // A parte do buy-in reservada pro prêmio de K.O. (bounty) já saiu do
  // clube ao longo do torneio, toda vez que alguém era eliminado — não
  // pode entrar de novo na premiação por colocação, senão paga em
  // dobro. Só o que NUNCA foi reclamado (o bounty do próprio campeão,
  // já que ele nunca é eliminado) continua disponível aqui.
  const totalBountyPaid = finalEntries.reduce((s, e) => s + Number(e.bounty_won || 0), 0);
  const prizePool = Math.max(Number(t.gtd_prize) || 0, totalBuyIns - totalBountyPaid);
  const activeFinal = finalEntries.filter((e) => e.status !== "cancelled");
  const itmBase = tournamentItmBaseCount(activeFinal, t.itm_mode || "buyins");
  const fractions = tournamentPayoutFractions(itmBase, Number(t.payout_percent) || 12, t.payout_weighting || "standard");
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
    // Carreira: prêmio ganho é ficha real do clube de verdade.
    await recordHandLedger(t.club_id, null, paidEntries[i].user_id, prize);
  }
  // K.O. Progressivo: o campeão nunca é eliminado, então o pote de
  // bounty PRÓPRIO dele (que só cresceu a cada eliminação que ele fez)
  // nunca foi pago — paga pra ele agora, à parte da premiação por
  // colocação.
  if (t.ko_mode === "progressive" && paidEntries[0]) {
    const champion = await getTournamentEntry(t.id, paidEntries[0].user_id);
    const leftover = Number(champion?.bounty_pool || 0);
    if (leftover > 0) {
      await adjustMemberChips(t.club_id, paidEntries[0].user_id, leftover);
      await adjustClubTreasury(t.club_id, -leftover);
      await recordHandLedger(t.club_id, null, paidEntries[0].user_id, leftover);
    }
  }
  // K.O. Misterioso: se sobrou pote sem sortear (torneio acabou rápido
  // demais pra consumir todos os prêmios sorteados, ou nunca chegou a
  // sortear), o resto vai pro campeão — não pode ficar perdido dentro
  // da tesouraria sem dono.
  if (t.ko_mode === "mystery" && paidEntries[0]) {
    const leftoverPool = Number(t.mystery_pool || 0);
    if (leftoverPool > 0) {
      await adjustMemberChips(t.club_id, paidEntries[0].user_id, leftoverPool);
      await adjustClubTreasury(t.club_id, -leftoverPool);
      await recordHandLedger(t.club_id, null, paidEntries[0].user_id, leftoverPool);
    }
  }
  await updateTournament(t.id, { status: "finished", finishedAt: new Date().toISOString() });
  // Limpa os runtimes das mesas desse torneio.
  for (const [code, rt] of runtime.entries()) {
    if (rt.tournamentId === t.id) runtime.delete(code);
  }
  await scheduleRecurringTournament(t);
}

// "MTT recorrente": cria automaticamente o próximo torneio com a MESMA
// configuração, no próximo dia da semana marcado em
// advanced_flags.recurring.days (0=domingo...6=sábado), no mesmo
// horário do torneio que acabou de terminar. Simplificação assumida:
// não tem a tela "Padrões de mesa" do pppoker pra listar/pausar/excluir
// os recorrentes separadamente — cada novo torneio criado aparece na
// lista normal de Torneios do clube, e pra parar a recorrência é só
// editar esse novo torneio e desligar a opção antes dele também acabar.
async function scheduleRecurringTournament(t) {
  const flags = t.advanced_flags || {};
  const rec = flags.recurring;
  if (!rec?.enabled || !Array.isArray(rec.days) || rec.days.length === 0) return;
  try {
    const prevStart = new Date(t.start_time);
    let next = new Date(prevStart.getTime());
    for (let i = 1; i <= 14; i++) {
      next = new Date(prevStart.getTime() + i * 86400000);
      if (rec.days.includes(next.getDay())) break;
    }
    await createTournament({
      clubId: t.club_id, name: t.name, variant: t.variant, buyIn: Number(t.buy_in), startingChips: Number(t.starting_chips),
      maxPlayers: t.max_players, minPlayers: t.min_players, blindStructure: t.blind_structure, levelMinutes: t.level_minutes,
      lateRegMinutes: t.late_reg_minutes, rebuyAllowed: t.rebuy_allowed, rebuyMax: t.rebuy_max, gtdPrize: Number(t.gtd_prize),
      startTime: next.toISOString(), createdBy: t.created_by,
      earlyBirdDiscountPct: t.early_bird_discount_pct, earlyBirdDeadline: null,
      bountyEnabled: t.bounty_enabled, bountyPercent: t.bounty_percent, payoutPercent: t.payout_percent,
      rebuyMultiplier: t.rebuy_multiplier, rebuyDouble: t.rebuy_double, rebuyTriple: t.rebuy_triple,
      addonEnabled: t.addon_enabled, addonMultiplier: t.addon_multiplier, addonDouble: t.addon_double, addonTriple: t.addon_triple,
      addonPauseMinutes: t.addon_pause_minutes, koMode: t.ko_mode, itmMode: t.itm_mode, payoutWeighting: t.payout_weighting,
      earlyBirdChipBonusPct: t.early_bird_chip_bonus_pct, earlyBirdChipBonusLevel: t.early_bird_chip_bonus_level,
      lateRegLevel: t.late_reg_level, customBlindLevels: t.custom_blind_levels, advancedFlags: flags,
    });
  } catch (err) {
    console.error(`Erro criando MTT recorrente a partir do torneio #${t.id}:`, err.message);
  }
}

// Toca uma mesa de torneio sozinha: inicia a próxima mão, marca quem
// zerou como eliminado (com a colocação certa) e verifica se o torneio
// já deve terminar. Chamado depois de cada broadcastTable de uma mesa
// marcada como isTournament.
// Paga o prêmio de K.O. de acordo com o modo escolhido na criação do
// torneio (t.ko_mode), chamado uma vez por jogador eliminado, com quem
// eliminou já identificado (eliminatorUser pode ser null se não achou
// ninguém — nesse caso não paga nada em nenhum modo).
// - "regular": paga o valor cheio na hora, sempre a mesma % do buy-in.
// - "progressive": só metade do POTE PRÓPRIO da vítima vai pro
//   eliminador agora; a outra metade entra no pote do eliminador (só é
//   pago quando ELE for eliminado, ou devolvido a ele no fim se virar
//   campeão — ver finishTournament).
// - "mystery": nenhum prêmio antes da fase ITM (só acumula em
//   tournaments.mystery_pool); ao entrar na fase ITM, sorteia de uma vez
//   os prêmios das eliminações restantes (generateMysteryPrizes) e paga
//   um por eliminação daí em diante.
async function payKnockoutBounty(t, eliminatorUser, victimEntry, activeEntriesBeforeThis) {
  const mode = t.bounty_enabled ? (t.ko_mode || "regular") : "off";
  if (mode === "off" || !eliminatorUser) return;
  const bountyAmount = Math.round(Number(t.buy_in) * Number(t.bounty_percent) / 100);
  if (bountyAmount <= 0) return;

  const payEliminator = async (amount) => {
    if (amount <= 0) return;
    await adjustMemberChips(t.club_id, eliminatorUser.id, amount);
    await adjustClubTreasury(t.club_id, -amount);
    const eliminatorEntry = await getTournamentEntry(t.id, eliminatorUser.id);
    await updateTournamentEntry(t.id, eliminatorUser.id, { bounty_won: Number(eliminatorEntry?.bounty_won || 0) + amount });
    // Carreira: bounty ganho é ficha real do clube de verdade.
    await recordHandLedger(t.club_id, null, eliminatorUser.id, amount);
  };

  if (mode === "regular") {
    await payEliminator(bountyAmount);
    return;
  }

  if (mode === "progressive") {
    // Se a vítima nunca fez rebuy (pote ainda não foi semeado por algum
    // motivo), cai pro valor cheio do buy-in atual, igual o Regular.
    const victimPool = Number(victimEntry?.bounty_pool || 0) || bountyAmount;
    const half = Math.round(victimPool / 2);
    await payEliminator(half);
    const eliminatorEntry = await getTournamentEntry(t.id, eliminatorUser.id);
    await updateTournamentEntry(t.id, eliminatorUser.id, { bounty_pool: Number(eliminatorEntry?.bounty_pool || 0) + (victimPool - half) });
    return;
  }

  if (mode === "mystery") {
    const paidSpots = Math.max(1, Math.round(
      tournamentItmBaseCount(activeEntriesBeforeThis, t.itm_mode || "buyins") * (Number(t.payout_percent) || 12) / 100
    ));
    // Ainda longe da fase ITM: só acumula, sem sortear nem pagar nada.
    if (activeEntriesBeforeThis.length > paidSpots) {
      const pool = Number(t.mystery_pool || 0) + bountyAmount;
      await updateTournament(t.id, { mystery_pool: pool });
      t.mystery_pool = pool;
      return;
    }
    const flags = t.advanced_flags || {};
    let prizes = flags.mysteryPrizes;
    if (!Array.isArray(prizes)) {
      // Primeira eliminação já dentro (ou entrando agora) na fase ITM —
      // sorteia de uma vez os prêmios de todas as eliminações que ainda
      // faltam até o heads-up, com o pote acumulado até aqui + essa.
      const pool = Number(t.mystery_pool || 0) + bountyAmount;
      const slots = Math.max(1, activeEntriesBeforeThis.length - 1);
      prizes = generateMysteryPrizes(pool, slots);
      await updateTournament(t.id, { advanced_flags: { ...flags, mysteryPrizes: prizes }, mystery_pool: 0 });
      t.advanced_flags = { ...flags, mysteryPrizes: prizes };
      t.mystery_pool = 0;
    } else {
      // Sorteio já feito — contribuições depois disso (rebuy/add-on late)
      // só voltam a acumular; são devolvidas ao campeão no fim.
      const pool = Number(t.mystery_pool || 0) + bountyAmount;
      await updateTournament(t.id, { mystery_pool: pool });
      t.mystery_pool = pool;
    }
    const prizeValue = prizes.length ? prizes.shift() : 0;
    await updateTournament(t.id, { advanced_flags: { ...(t.advanced_flags || {}), mysteryPrizes: [...prizes] } });
    t.advanced_flags = { ...(t.advanced_flags || {}), mysteryPrizes: [...prizes] };
    await payEliminator(prizeValue);
    return;
  }
}

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
    try {
    rt.pulseScheduled = false;
    if (runtime.get(code)?.table !== table) return;
    // Sincroniza fichas atuais de quem jogou essa mão com a linha do
    // torneio, e marca eliminado quem zerou.
    const stillPlaying = (await listTournamentEntries(t.id)).filter((e) => e.status === "playing");
    // Prêmio de K.O. (bounty): parte do buy-in de cada jogador fica
    // reservada só pra isso — quando alguém zera, quem eliminou recebe
    // na hora, direto no saldo real do clube (não em fichas de torneio).
    // Acha o "eliminador" pela maior variação positiva de fichas nessa
    // mesma mão (aproximação razoável sem rastrear mão a mão quem
    // apostou contra quem).
    const deltas = table.lastHandDeltas || {};
    for (const p of table.players) {
      // p.id na mesa é o NOME do jogador (username) — mas
      // updateTournamentEntry precisa do ID numérico de verdade. Esse
      // era o bug: sem essa conversão, o UPDATE nunca batia com
      // nenhuma linha (comparava string com número), e ninguém nunca
      // era marcado como eliminado de verdade, então o torneio nunca
      // avançava/terminava depois de alguém zerar.
      const puser = await findUserByUsername(p.id);
      if (!puser) continue;
      if (p.chips > 0) { await updateTournamentEntry(t.id, puser.id, { chips: p.chips }); continue; }
      const remaining = stillPlaying.length; // quantos ainda restavam de verdade nesse instante
      const victimEntry = await getTournamentEntry(t.id, puser.id);
      await updateTournamentEntry(t.id, puser.id, { status: "eliminated", chips: 0, rank: remaining, eliminatedAt: new Date().toISOString() });
      if (t.bounty_enabled) {
        const survivors = table.players.filter((q) => q.id !== p.id && q.chips > 0);
        const eliminator = survivors.sort((a, b) => (deltas[b.id] || 0) - (deltas[a.id] || 0))[0];
        const eliminatorUser = eliminator ? await findUserByUsername(eliminator.id) : null;
        await payKnockoutBounty(t, eliminatorUser, victimEntry, stillPlaying);
      }
    }
    table.players = table.players.filter((p) => p.chips > 0);

    const nowActive = (await listTournamentEntries(t.id)).filter((e) => e.status === "playing");
    if (nowActive.length <= 1) { await finishTournament(t); return; }

    if (table.players.length >= 2) {
      table.startHand();
      broadcastTable(code);
    }
    } catch (err) {
      console.error("Erro processando fim de mão de torneio:", err.message);
    }
  }, table.stage === "showdown" ? 4000 : 300);
}

// Roda a cada 15s: sobe o nível de blind de torneios em andamento cujo
// tempo do nível atual já passou, e inicia torneios agendados cujo
// horário já chegou.
// Relógio de inatividade: cada jogador tem 30s pra agir, mais 10s de
// tolerância (o cliente mostra isso como "acabou, +10s"). Estourado
// isso, age por ele — passa se der de graça, senão desiste e marca
// "ausente" na mesa (fica assim até ele mesmo agir nela de novo).
const ACTION_GRACE_MS = 10000; // +10s de tolerância depois do "Tempo de ação" configurado da mesa
// Se alguém desconectar ou simplesmente não votar em "Bater 2x/3x"
// (precisa de TODOS os envolvidos), o jogo não pode travar pra sempre
// esperando — depois desse tempo, resolve sozinho como 1x (segue
// revelando normal, exatamente como se ninguém tivesse pedido Run It).
const RUN_IT_VOTE_TIMEOUT_MS = 20000;

function tickActionTimeouts() {
  const now = Date.now();
  for (const [code, rt] of runtime.entries()) {
    const table = rt.table;
    if (table?.runItPending && table.runItPendingSince && now - table.runItPendingSince >= RUN_IT_VOTE_TIMEOUT_MS) {
      table.finalizeRunIt(1);
      broadcastTable(code);
    }
    if (!table || !table.actingId) continue;
    const p = table.players.find((pl) => pl.id === table.actingId);
    if (!p || p.isBot) continue; // bots já têm o próprio relógio (pulseQuickTable)
    if (table.actingId !== rt._lastActingId) {
      rt._lastActingId = table.actingId;
      rt._actingSince = now;
      continue;
    }
    const timeoutMs = (Number(table.actionSeconds) || 30) * 1000 + ACTION_GRACE_MS;
    if (now - (rt._actingSince || now) >= timeoutMs) {
      table.autoTimeoutAction(table.actingId);
      rt._lastActingId = table.actingId; // pode já ser o próximo jogador
      rt._actingSince = now;
      broadcastTable(code);
    }
  }
}

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
        const blinds = tournamentBlindLevel(t, nextLevel);
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

// "Duração da mesa" + "Extensão automática" — só arma o relógio na
// primeira vez que a mesa é criada de verdade (rt.table === null antes
// dessa chamada); reconectar ou outra pessoa sentar depois não reseta o
// prazo. duration_minutes=0 quer dizer sem limite (não arma nada).
function setupTableDuration(rt, t) {
  if (rt.tableClosesAt !== undefined) return; // já armado antes, não pisa em cima
  const minutes = Number(t.duration_minutes) || 0;
  rt.tableClosesAt = minutes > 0 ? Date.now() + minutes * 60000 : null;
  rt.tableAutoExtend = !!t.auto_extend;
  rt.tableExtendsLeft = Number(t.auto_extend_times) || 0;
}

// Roda periodicamente: mesa de clube com prazo vencido fecha (todo
// mundo recebe as fichas de volta no Royalle Pay) a menos que a
// Extensão automática esteja ligada, ainda tenha "vezes" sobrando, e a
// mesa tenha pelo menos 2 jogadores — aí soma mais 1h e desconta uma
// extensão, igual a regra descrita.
async function tickTableDurations() {
  const now = Date.now();
  for (const [code, rt] of runtime.entries()) {
    if (!rt.tableClosesAt || now < rt.tableClosesAt || !rt.table) continue;
    if (rt.tableAutoExtend && rt.tableExtendsLeft > 0 && rt.table.players.length >= 2) {
      rt.tableClosesAt = now + 60 * 60000;
      rt.tableExtendsLeft -= 1;
      rt.table.addLog?.(`Mesa estendida automaticamente por mais 1h (${rt.tableExtendsLeft} extensão(ões) restante(s)).`);
      broadcastTable(code);
      continue;
    }
    // Fecha de vez: devolve fichas de quem estiver sentado e desliga o
    // prazo (não fecha de novo sozinha depois disso).
    if (rt.clubId) {
      for (const p of [...rt.table.players]) {
        const user = await findUserByUsername(p.id);
        if (user) await adjustMemberChips(rt.clubId, user.id, p.chips);
      }
    }
    rt.table.players = [];
    rt.tableClosesAt = null;
    rt.table.addLog?.("A mesa encerrou — duração configurada terminou.");
    broadcastTable(code);
  }
}

// Distância em metros entre duas coordenadas — fórmula de haversine,
// usada só pela "Restrição de GPS".
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
  // Agentes de RAKE ativos desse clube também enxergam o saldo do clube
  // (precisam pra saber quanto podem enviar pros membros da própria
  // carteira) — busca uma vez só pra não fazer uma consulta por socket.
  const activeAgentUserIds = new Set(
    (await listAgentWallets(rt.clubId)).filter((a) => a.status === "active").map((a) => a.user_id)
  );
  for (const ws of rt.sockets) {
    const member = members.find((m) => m.username === ws.username);
    const viewerIsOwner = member?.role === "owner" || member?.role === "agent" || (member && activeAgentUserIds.has(member.id));
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
  for (const { username, userId, stayInRoom } of [...rt.pendingLeave]) {
    const player = rt.table.players.find((p) => p.id === username);
    if (player) {
      if (rt.isQuick) await adjustQuickWalletChips(userId, player.chips);
      else await adjustMemberChips(rt.clubId, userId, player.chips);
      freezeSessionResult(rt.table, username, player.chips);
      rt.table.removePlayer(username);
    }
    // "Levantar" (stayInRoom): continua conectado à mesa vendo ao vivo,
    // só sai de fato de jogar — por isso NÃO mexe em socketToPlayer aqui.
    if (!stayInRoom) {
      for (const [ws, u] of [...rt.socketToPlayer.entries()]) {
        if (u === username) rt.socketToPlayer.delete(ws);
      }
    }
  }
  resetIfEmpty(rt);
  rt.pendingLeave.clear();
  if (!rt.isQuick) await broadcastClub(clubCode);
  if (runtime.has(code)) broadcastTable(code);
}

// Depois que o dono liga/desliga o jackpot ou injeta ficha manual, as
// mesas do clube que já estão abertas precisam refletir isso na hora —
// sem esperar a próxima mão terminar. Varre o runtime, atualiza só as
// mesas desse clube e reenvia o estado.
async function refreshJackpotOnRuntimes(clubId) {
  const club = await getClubById(clubId);
  if (!club) return;
  for (const [code, rt] of runtime.entries()) {
    if (rt.clubId !== clubId || !rt.table) continue;
    rt.jackpotEnabled = !!club.jackpot_enabled;
    rt.jackpotBalance = Number(club.jackpot_balance || 0);
    broadcastTable(code);
  }
}

function broadcastTable(code) {
  const rt = runtime.get(code);
  const table = rt?.table;
  if (!table) return;
  for (const [ws, username] of rt.socketToPlayer.entries()) {
    send(ws, { type: "table_state", state: { ...table.getPublicState(username), tableName: rt.tableName || null, tableId: rt.tableId ?? null, jackpotEnabled: !!rt.jackpotEnabled, jackpotBalance: Number(rt.jackpotBalance || 0), autoStart: rt.autoStart !== false, minStartPlayers: rt.minStartPlayers || 2, chatBanned: !!rt.chatBanned } });
  }
  maybeRecordRake(rt, code);
  maybeAwardJackpot(rt, code);
  maybeUpdateTablePlayerStats(rt, code);
  maybeRecordHandLedger(rt, code);
  if (table.eligibleForSplitEv()) {
    // Só oferece nos 900ms normais de decisão entre ruas (mesmo delay
    // do runout automático) — dá um instante pra UI mostrar a % antes
    // de já fechar por equidade.
    setTimeout(() => {
      if (rt.table !== table || !table.eligibleForSplitEv()) return;
      table.settleBySplitEv();
      broadcastTable(code);
    }, 900);
  } else if (table.needsAutoRunout()) {
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

async function maybeRecordRake(rt, code) {
  const clubAmount = rt.table?.pendingRake || 0;
  const platformAmount = rt.table?.pendingPlatformRake || 0;
  const byPlayer = rt.table?.pendingRakeByPlayer || {};
  if (clubAmount > 0 || platformAmount > 0) {
    rt.table.pendingRake = 0;
    rt.table.pendingPlatformRake = 0;
    rt.table.pendingRakeByPlayer = {};
    // Antes de gravar o rake do clube, separa a fatia do jackpot (se
    // estiver ligado) — o resto continua indo pro rake normal igual
    // sempre foi. O jackpot nunca reduz o que o jogador recebe: essa
    // fatia já era do clube, só troca de bolso.
    let clubAmountAfterJackpot = clubAmount;
    if (rt.clubId && clubAmount > 0) {
      const club = await getClubById(rt.clubId);
      rt.jackpotEnabled = !!club?.jackpot_enabled;
      rt.jackpotBalance = Number(club?.jackpot_balance || 0);
      if (club?.jackpot_enabled && Number(club.jackpot_rake_percent) > 0) {
        const jackpotCut = Math.floor((clubAmount * Number(club.jackpot_rake_percent)) / 100);
        if (jackpotCut > 0) {
          rt.jackpotBalance = await addJackpotChips(rt.clubId, jackpotCut);
          clubAmountAfterJackpot -= jackpotCut;
        }
      }
    }
    if (rt.clubId) await recordRake(rt.clubId, clubAmountAfterJackpot, platformAmount);
    // Sistema de rake/rakeback/agente — só faz sentido em mesa de CLUBE
    // de verdade (fichas reais), nunca em mesa pública/torneio (fichas
    // fictícias, sem membro de clube por trás). Um evento por jogador,
    // com a % que estava valendo NAQUELE instante (não recalcula depois).
    if (rt.clubId && !rt.isQuick && !rt.isTournament) {
      for (const [username, amount] of Object.entries(byPlayer)) {
        if (!(amount > 0)) continue;
        const user = await findUserByUsername(username);
        if (user) await recordRakeEvent(rt.clubId, user.id, code || null, amount);
      }
    }
    // O dono precisa ver o rake do clube E o rake do app atualizarem na
    // hora, sem precisar sair e entrar de novo no clube.
    if (rt.clubCode) await broadcastClub(rt.clubCode);
  }
}

// Espelha (server-side) as mesmas tabelas de premiação que aparecem nos
// popups "?" da tela de configuração — mesma fonte (documentação oficial
// que o Carlos mandou), só reorganizada por variante pra ser fácil de
// consultar aqui. Cooler/Cooler Plus não pagam Mão Forte (não existe essa
// seção nos dois documentos deles); só o Mixed paga os dois.
const JACKPOT_COOLER_PCT = {
  mixed:       { holdem: { quads: 50, straightflush: 80 }, plo4: { quads: 33, straightflush: 52 }, plo5: { quads: 23, straightflush: 36 }, plo6: { quads: 13, straightflush: 20 } },
  cooler:      { holdem: { quads: 65, straightflush: 90 }, plo4: { quads: 46, straightflush: 63 }, plo5: { quads: 33, straightflush: 45 }, plo6: { quads: 20, straightflush: 27 } },
  cooler_plus: { holdem: { quads: 65, straightflush: 90 }, plo4: { quads: 46, straightflush: 63 }, plo5: { quads: 33, straightflush: 45 }, plo6: { quads: 20, straightflush: 27 } },
};
const JACKPOT_STRONG_PCT = {
  mixed: { holdem: { quads: 1, straightflush: 4, royal: 14 }, plo4: { straightflush: 1.2, royal: 4.2 }, plo5: { straightflush: 0.8, royal: 2.8 } },
};

// Paga de verdade um Cooler/Mão Forte detectado na última mão dessa
// mesa — independe de ter havido rake (por isso roda fora do `if` do
// maybeRecordRake). Só mexe em fichas de quem ainda está sentado; quem
// já saiu da mesa perde a parte (a regra também diz isso: "jogadores
// que deixarem a mesa antes do fim da mão não se qualificam").
async function maybeAwardJackpot(rt, code) {
  const event = rt.table?.pendingJackpotEvent;
  const dealtIds = rt.table?.pendingJackpotDealtIds || [];
  if (!event) return;
  rt.table.pendingJackpotEvent = null;
  rt.table.pendingJackpotDealtIds = [];
  if (!rt.clubId) return;
  const club = await getClubById(rt.clubId);
  if (!club?.jackpot_enabled) return;
  const type = club.jackpot_type || "mixed";
  if (event.kind === "cooler" && dealtIds.length < 3) return; // "pelo menos 3 jogadores devem receber uma mão"
  if (event.kind === "strong" && type !== "mixed") return; // Cooler/Cooler Plus não pagam Mão Forte

  const variant = rt.table.variant;
  const pctTable = event.kind === "cooler" ? JACKPOT_COOLER_PCT[type]?.[variant] : JACKPOT_STRONG_PCT[type]?.[variant];
  // No Cooler, a coluna certa da tabela depende do que a mão PERDEDORA
  // era (Full House de valetes+ não tem % nas tabelas — fica de fora,
  // igual o "—" nos documentos).
  const key = event.kind === "cooler"
    ? (event.loserCategory >= 8 ? "straightflush" : event.loserCategory === 7 ? "quads" : null)
    : event.trigger;
  const pct = pctTable?.[key];
  if (!pct) return;

  const jackpotBalance = Number(club.jackpot_balance || 0);
  const prize = Math.floor((jackpotBalance * pct) / 100);
  if (prize <= 0) return;

  const others = dealtIds.filter((id) => id !== event.winnerId && id !== event.loserId);
  const shares = {}; // playerId -> fichas
  if (event.kind === "cooler") {
    if (others.length === 0) {
      shares[event.winnerId] = Math.round(prize * 0.4);
      shares[event.loserId] = prize - shares[event.winnerId];
    } else {
      shares[event.winnerId] = Math.round(prize * 0.3);
      shares[event.loserId] = Math.round(prize * 0.5);
      const othersTotal = prize - shares[event.winnerId] - shares[event.loserId];
      const per = Math.floor(othersTotal / others.length);
      let rem = othersTotal - per * others.length;
      others.forEach((id) => { shares[id] = per + (rem > 0 ? 1 : 0); if (rem > 0) rem--; });
    }
  } else {
    if (others.length === 0) {
      shares[event.winnerId] = prize;
    } else {
      shares[event.winnerId] = Math.round(prize * 0.8);
      const othersTotal = prize - shares[event.winnerId];
      const per = Math.floor(othersTotal / others.length);
      let rem = othersTotal - per * others.length;
      others.forEach((id) => { shares[id] = per + (rem > 0 ? 1 : 0); if (rem > 0) rem--; });
    }
  }

  // Só credita quem ainda está sentado na mesa — o resto (quem já
  // levantou) fica de fora do que efetivamente sai do pote, mesmo tendo
  // "direito" na regra, porque não tem onde depositar a ficha.
  let actuallyPaid = 0;
  for (const [id, amount] of Object.entries(shares)) {
    if (!(amount > 0)) continue;
    const player = rt.table.players.find((p) => p.id === id);
    if (!player) continue;
    player.chips += amount;
    actuallyPaid += amount;
  }
  if (actuallyPaid <= 0) return;

  rt.jackpotBalance = await addJackpotChips(rt.clubId, -actuallyPaid);
  const label = event.kind === "cooler" ? "Jackpot Cooler" : "Jackpot Mão Forte";
  rt.table.addLog?.(`${label}! ${actuallyPaid.toLocaleString("pt-BR")} fichas distribuídas do pote.`);
  broadcastTable(code);
  if (rt.clubCode) await broadcastClub(rt.clubCode);
}

// Carreira: só mesas de CLUBE contam (fichas fictícias de "Jogar" fora de
// clube nunca entram aqui). Guarda o ganho/perda de cada jogador logo
// depois que a mão termina, e zera lastHandDeltas pra não gravar de novo
// nos próximos broadcasts dessa mesma mão.
async function maybeRecordHandLedger(rt, code) {
  const deltas = rt.table?.lastHandDeltas;
  if (!deltas || rt.isQuick || !rt.clubId) { if (deltas) rt.table.lastHandDeltas = null; return; }
  rt.table.lastHandDeltas = null;
  // Mesas de TORNEIO nunca entram na carreira mão a mão — a "ficha" ali é
  // uma unidade fictícia do torneio (pode ser 10.000 fichas de torneio
  // pra um buy-in real de 1.000), completamente diferente de fichas reais
  // do clube. Registrar esse delta bruto na carreira mostraria números
  // sem sentido (ex: "-10k" quando a pessoa só perdeu o buy-in de 1k de
  // verdade). O que conta pra carreira de torneio é só o buy-in/recompra
  // pago e o prêmio ganho — isso é registrado à parte, nos pontos exatos
  // em que dinheiro real muda de mão (ver register_tournament,
  // rebuy_tournament e finishTournament).
  if (rt.isTournament) return;
  const tableId = code.includes("#") ? Number(code.split("#")[1]) : null;
  for (const [playerId, delta] of Object.entries(deltas)) {
    const user = await findUserByUsername(playerId);
    if (user) await recordHandLedger(rt.clubId, tableId, user.id, delta);
  }
}

// VPIP ("Nv. de VPIP") e lucro de sessão (pro "Tempo decretado") —
// atualiza um por um a cada mão resolvida. Só mesa de clube de verdade
// (fichas reais), igual o resto do sistema de estatística.
async function maybeUpdateTablePlayerStats(rt, code) {
  const vpipMap = rt.table?.lastHandVpip;
  if (!vpipMap || rt.isQuick || rt.isTournament || !rt.clubId) { if (vpipMap) rt.table.lastHandVpip = null; return; }
  rt.table.lastHandVpip = null;
  const deltas = rt.table?.lastHandDeltas || {};
  const tableId = code.includes("#") ? Number(code.split("#")[1]) : null;
  if (!tableId) return;
  const t = await getClubTableById(rt.clubId, tableId);
  for (const [playerId, vpip] of Object.entries(vpipMap)) {
    const user = await findUserByUsername(playerId);
    if (!user) continue;
    const stats = await bumpTablePlayerStats(tableId, user.id, { vpip, profitDelta: deltas[playerId] || 0 });
    // "Nv. de VPIP": depois de rodar o limite de mãos configurado, quem
    // tá jogando MAIS apertado que o mínimo exigido é removido da mesa
    // (a regra é "abaixo do nível exigido é removido" — não é castigo
    // por jogar solto demais, é o contrário: exige um mínimo de VPIP).
    const flags = t?.advanced_flags || {};
    const vpipLevel = Number(flags.vpipLevelPct || 0);
    const vpipHandLimit = Number(flags.vpipHandLimit || 30);
    if (flags.vpipLevel && vpipLevel > 0 && stats.hands_played >= vpipHandLimit) {
      const pct = (stats.hands_vpip / stats.hands_played) * 100;
      if (pct < vpipLevel) {
        const p = rt.table?.players?.find((pl) => pl.id === playerId);
        if (p && !p.away) {
          rt.table.players = rt.table.players.filter((pl) => pl.id !== playerId);
          rt.table.addLog?.(`${p.name} foi removido da mesa por VPIP abaixo do exigido.`);
          await adjustMemberChips(rt.clubId, user.id, p.chips);
        }
      }
    }
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
  const { level, gestor: gestorCap, membro: membroCap } = effectiveClubLevel(club);
  const base = {
    id: club.id,
    code: club.code,
    name: club.name,
    image: club.image || null,
    coverImage: club.cover_image || null,
    level, gestorCap, membroCap,
    levelExpiresAt: level > 0 ? club.level_expires_at : null,
    smallBlind: club.small_blind,
    bigBlind: club.big_blind,
    buyIn: club.buy_in,
    rakePercent: Number(club.rake_percent),
    ownerId: club.owner_id,
    // O saldo do jackpot é vitrine — todo membro vê quanto tem
    // acumulado (igual o telão de cassino), só a configuração (% do
    // rake) é administrativa.
    jackpotEnabled: !!club.jackpot_enabled,
    jackpotBalance: Number(club.jackpot_balance || 0),
  };
  // Tesouraria e rake acumulado são informação administrativa — só o
  // dono/admin recebe esses campos. Pra membro comum, nem chegam a existir
  // no payload (não é só esconder na interface).
  if (viewerIsOwner) {
    return { ...base, treasuryChips: Number(club.treasury_chips), totalRake: extra.totalRake ?? 0, platformRake: extra.platformRake ?? 0, jackpotRakePercent: Number(club.jackpot_rake_percent || 0), jackpotType: club.jackpot_type || "mixed", jackpotFeeMode: club.jackpot_fee_mode || "per_pot" };
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

// Royalle Master — só quem tem platform_role='super_admin' passa daqui.
// Sempre confere no SERVIDOR (nunca confia em nada que o cliente diga
// sobre si mesmo) — é o mesmo princípio do requireAuth, só que checando
// permissão de PLATAFORMA em vez de só "tá logado".
async function requireSuperAdmin(ws, ctx) {
  if (!requireAuth(ws, ctx)) return false;
  const role = await getUserPlatformRole(ws.userId);
  if (role !== "super_admin") { ctx.reply({ ok: false, error: "Sem permissão de administrador da plataforma." }); return false; }
  return true;
}

async function handleMessage(ws, msg, ctx) {
  const { type } = msg;

  // ============================================================
  // ROYALLE MASTER — painel administrativo da PLATAFORMA. Só quem tem
  // platform_role='super_admin' (checado no servidor, sempre) passa
  // daqui. Nada aqui mexe na lógica de poker/mesas — é tudo consulta e
  // administração (clube, usuário, diamante, condição comercial, nível,
  // log). Toda ação que MUDA algo grava em admin_audit_logs.
  // ============================================================
  if (type === "master_get_dashboard") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const from = msg.from || new Date(Date.now() - 30 * 86400000).toISOString();
    const to = msg.to || new Date().toISOString();
    const [clubs, users, financial, diamondTxs] = await Promise.all([
      listAllClubsForMaster(), listAllUsersForMaster(), getPlatformFinancialSummary(from, to), listDiamondTransactions({ limit: 500 }),
    ]);
    const now = Date.now();
    const todayStart = new Date(new Date().toDateString()).getTime();
    const clubsActive = clubs.filter((c) => c.status === "active" || !c.status).length;
    const clubsBlocked = clubs.filter((c) => c.status === "blocked" || c.status === "suspended").length;
    const clubsExpiring7d = clubs.filter((c) => c.level_expires_at && new Date(c.level_expires_at).getTime() - now < 7 * 86400000 && new Date(c.level_expires_at).getTime() > now).length;
    const clubsExpiring3d = clubs.filter((c) => c.level_expires_at && new Date(c.level_expires_at).getTime() - now < 3 * 86400000 && new Date(c.level_expires_at).getTime() > now).length;
    const clubsExpired = clubs.filter((c) => c.level_expires_at && new Date(c.level_expires_at).getTime() <= now).length;
    const usersActiveToday = users.filter((u) => u.last_seen && new Date(u.last_seen).getTime() >= todayStart).length;
    const owners = clubs.length; // 1 dono por clube
    const agentsTotal = clubs.reduce((s, c) => s + Number(c.agent_count || 0), 0);
    const diamondsSoldToday = diamondTxs.filter((t) => t.type === "manual_sale" && new Date(t.created_at).getTime() >= todayStart).reduce((s, t) => s + t.diamonds_delta, 0);
    const activeTablesNow = Array.from(runtime.values()).filter((rt) => rt.table).length;
    ctx.reply({
      ok: true,
      clubs: { total: clubs.length, active: clubsActive, blocked: clubsBlocked, expiring7d: clubsExpiring7d, expiring3d: clubsExpiring3d, expired: clubsExpired },
      users: { total: users.length, activeToday: usersActiveToday, owners, agents: agentsTotal },
      diamonds: { soldToday: diamondsSoldToday, soldPeriod: financial.diamondsSold, revenueBrlPeriod: financial.diamondRevenueBrl, transactionCountPeriod: financial.diamondTransactionCount },
      financial,
      operation: { activeTablesNow },
    });
    return;
  }

  if (type === "master_list_clubs") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const clubs = await listAllClubsForMaster();
    ctx.reply({ ok: true, clubs });
    return;
  }

  if (type === "master_get_club_detail") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const club = await getClubForMasterDetail(Number(msg.clubId));
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const [members, condition, conditionHistory, levelTier] = await Promise.all([
      listMembers(club.id), getActiveCommercialCondition(club.id), listCommercialConditionHistory(club.id),
      Promise.resolve(effectiveClubLevel(club)),
    ]);
    ctx.reply({ ok: true, club, members, condition, conditionHistory, levelTier });
    return;
  }

  if (type === "master_set_club_status") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    if (!["active", "blocked", "suspended"].includes(msg.status)) return ctx.reply({ ok: false, error: "Status inválido." });
    const club = await getClubForMasterDetail(Number(msg.clubId));
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const before = club.status || "active";
    await setClubStatus(club.id, msg.status);
    await recordAdminAuditLog({ adminId: ws.userId, action: "set_club_status", targetType: "club", targetId: club.id, before: { status: before }, after: { status: msg.status }, reason: msg.reason || null });
    ctx.reply({ ok: true, status: msg.status });
    return;
  }

  if (type === "master_list_users") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const users = await listAllUsersForMaster();
    ctx.reply({ ok: true, users });
    return;
  }

  if (type === "master_get_user_detail") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const user = await getUserForMasterDetail(Number(msg.userId));
    if (!user) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    const diamondHistory = await listDiamondTransactions({ userId: user.id, limit: 100 });
    ctx.reply({ ok: true, user, diamondHistory });
    return;
  }

  if (type === "master_set_user_status") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    if (!["active", "blocked", "suspended"].includes(msg.status)) return ctx.reply({ ok: false, error: "Status inválido." });
    const user = await getUserForMasterDetail(Number(msg.userId));
    if (!user) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    const before = user.status || "active";
    await setUserStatus(user.id, msg.status);
    await recordAdminAuditLog({ adminId: ws.userId, action: "set_user_status", targetType: "user", targetId: user.id, before: { status: before }, after: { status: msg.status }, reason: msg.reason || null });
    ctx.reply({ ok: true, status: msg.status });
    return;
  }

  if (type === "master_list_diamond_packages") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const packages = await listDiamondPackages(false);
    ctx.reply({ ok: true, packages });
    return;
  }

  if (type === "master_create_diamond_package") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const diamonds = Math.max(1, Number(msg.diamonds) || 0);
    const coinCost = Math.max(1, Number(msg.coinCost) || 0);
    const bonusDiamonds = Math.max(0, Number(msg.bonusDiamonds) || 0);
    const pkg = await createDiamondPackage({ diamonds, coinCost, bonusDiamonds, sortOrder: Number(msg.sortOrder) || 0 });
    await recordAdminAuditLog({ adminId: ws.userId, action: "create_diamond_package", targetType: "diamond_package", targetId: pkg.id, after: pkg });
    ctx.reply({ ok: true, package: pkg });
    return;
  }

  if (type === "master_update_diamond_package") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const before = (await listDiamondPackages(false)).find((p) => p.id === Number(msg.packageId));
    if (!before) return ctx.reply({ ok: false, error: "Pacote não encontrado." });
    const fields = {};
    if (msg.diamonds != null) fields.diamonds = Math.max(1, Number(msg.diamonds));
    if (msg.coinCost != null) fields.coinCost = Math.max(1, Number(msg.coinCost));
    if (msg.bonusDiamonds != null) fields.bonusDiamonds = Math.max(0, Number(msg.bonusDiamonds));
    if (msg.active != null) fields.active = !!msg.active;
    if (msg.sortOrder != null) fields.sortOrder = Number(msg.sortOrder);
    const pkg = await updateDiamondPackage(msg.packageId, fields);
    await recordAdminAuditLog({ adminId: ws.userId, action: "update_diamond_package", targetType: "diamond_package", targetId: pkg.id, before, after: pkg });
    ctx.reply({ ok: true, package: pkg });
    return;
  }

  // Venda manual de diamante — pra vendas fechadas por fora (WhatsApp,
  // PIX etc.), dinheiro real que o dono/admin recebeu FORA do app. O
  // app não processa pagamento nenhum; isso aqui só registra o que já
  // aconteceu e credita o diamante, com ledger completo (nunca só soma
  // saldo — ver creditDiamondsWithLedger).
  if (type === "master_manual_diamond_sale") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const target = await findUserByUsername(msg.targetUsername || "");
    if (!target) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    const diamonds = Math.round(Number(msg.diamonds));
    if (!(diamonds > 0)) return ctx.reply({ ok: false, error: "Quantidade de diamantes inválida." });
    const amountBrl = msg.amountBrl != null ? Number(msg.amountBrl) : null;
    const { transaction, balanceAfter } = await creditDiamondsWithLedger(target.id, diamonds, {
      type: "manual_sale", amountBrl, paymentMethod: msg.paymentMethod || null, channel: msg.channel || "whatsapp",
      note: msg.note || null, adminId: ws.userId,
    });
    await recordAdminAuditLog({ adminId: ws.userId, action: "manual_diamond_sale", targetType: "user", targetId: target.id, after: transaction, reason: msg.note || null });
    ctx.reply({ ok: true, transaction, balanceAfter });
    return;
  }

  if (type === "master_adjust_diamonds") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const target = await findUserByUsername(msg.targetUsername || "");
    if (!target) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    const delta = Math.round(Number(msg.delta));
    if (!delta) return ctx.reply({ ok: false, error: "Ajuste inválido." });
    const { transaction, balanceAfter } = await creditDiamondsWithLedger(target.id, delta, {
      type: "admin_adjust", note: msg.reason || null, adminId: ws.userId,
    });
    await recordAdminAuditLog({ adminId: ws.userId, action: "adjust_diamonds", targetType: "user", targetId: target.id, after: transaction, reason: msg.reason || null });
    ctx.reply({ ok: true, transaction, balanceAfter });
    return;
  }

  if (type === "master_list_diamond_transactions") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const transactions = await listDiamondTransactions({ userId: msg.userId ? Number(msg.userId) : null, limit: Math.min(500, Number(msg.limit) || 200) });
    ctx.reply({ ok: true, transactions });
    return;
  }

  if (type === "master_list_commercial_condition_history") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const history = await listCommercialConditionHistory(Number(msg.clubId));
    ctx.reply({ ok: true, history });
    return;
  }

  if (type === "master_set_commercial_condition") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const club = await getClubForMasterDetail(Number(msg.clubId));
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const before = await getActiveCommercialCondition(club.id);
    const condition = await setClubCommercialCondition(club.id, {
      model: msg.model || "standard",
      platformRakePercent: Number(msg.platformRakePercent) || 0,
      clubRakePercent: Number(msg.clubRakePercent) || 0,
      renewalPriceBrl: msg.renewalPriceBrl != null ? Number(msg.renewalPriceBrl) : null,
      renewalPeriodicityDays: msg.renewalPeriodicityDays != null ? Number(msg.renewalPeriodicityDays) : null,
      transferFeePercent: msg.transferFeePercent != null ? Number(msg.transferFeePercent) : 5,
      diamondDiscountPercent: Number(msg.diamondDiscountPercent) || 0,
      memberLimit: msg.memberLimit != null ? Number(msg.memberLimit) : null,
      tableLimit: msg.tableLimit != null ? Number(msg.tableLimit) : null,
      benefits: msg.benefits || null,
      endsAt: msg.endsAt || null,
    }, ws.userId, msg.reason || null);
    await recordAdminAuditLog({ adminId: ws.userId, action: "set_commercial_condition", targetType: "club", targetId: club.id, before, after: condition, reason: msg.reason || null });
    ctx.reply({ ok: true, condition });
    return;
  }

  if (type === "master_list_club_level_configs") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const levels = await listClubLevelConfigs();
    ctx.reply({ ok: true, levels });
    return;
  }

  if (type === "master_set_club_level_config") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const level = Number(msg.level);
    if (!(level >= 0)) return ctx.reply({ ok: false, error: "Nível inválido." });
    const before = (await listClubLevelConfigs()).find((l) => l.level === level) || null;
    const updated = await setClubLevelConfig(level, {
      gestorCap: Math.max(0, Number(msg.gestorCap) || 0),
      membroCap: Math.max(0, Number(msg.membroCap) || 0),
      priceDiamonds: Math.max(0, Number(msg.priceDiamonds) || 0),
      benefits: msg.benefits || null,
    }, ws.userId);
    await reloadClubLevelTiers(); // pega a mudança na hora, sem reiniciar o servidor
    await recordAdminAuditLog({ adminId: ws.userId, action: "set_club_level_config", targetType: "club_level", targetId: level, before, after: updated });
    ctx.reply({ ok: true, level: updated });
    return;
  }

  if (type === "master_list_audit_logs") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const logs = await listAdminAuditLogs({ limit: Math.min(500, Number(msg.limit) || 200) });
    ctx.reply({ ok: true, logs });
    return;
  }

  if (type === "master_get_financial_summary") {
    if (!(await requireSuperAdmin(ws, ctx))) return;
    const from = msg.from || new Date(Date.now() - 7 * 86400000).toISOString();
    const to = msg.to || new Date().toISOString();
    const [summary, clubs] = await Promise.all([getPlatformFinancialSummary(from, to), listAllClubsForMaster()]);
    // Fechamento por clube dentro do período — reaproveita rake_events
    // igual o fechamento normal de clube já faz, só que somando todos.
    const perClub = await Promise.all(clubs.map(async (c) => {
      const s = await getRakeSummary(c.id, from, to);
      return { clubId: c.id, clubName: c.name, ...s };
    }));
    ctx.reply({ ok: true, summary, perClub: perClub.filter((c) => c.grossRake > 0 || c.gross > 0) });
    return;
  }

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
    onlineByUsername.set(ws.username, ws);
    await touchLastSeen(user.id);
    const token = signToken(user.id, user.username);
    ctx.reply({ ok: true, token, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: null, nickname: user.nickname || null, platformRole: user.platform_role || null } });
    return;
  }

  if (type === "login") {
    const username = (msg.username || "").trim();
    const user = await findUserByUsername(username);
    if (!user) return ctx.reply({ ok: false, error: "Usuário ou senha incorretos." });
    const valid = await verifyPassword(msg.password || "", user.password_hash);
    if (!valid) return ctx.reply({ ok: false, error: "Usuário ou senha incorretos." });
    ws.userId = user.id; ws.username = user.username;
    onlineByUsername.set(ws.username, ws);
    await touchLastSeen(user.id);
    const token = signToken(user.id, user.username);
    ctx.reply({ ok: true, token, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: user.avatar_image || null, nickname: user.nickname || null, platformRole: user.platform_role || null } });
    return;
  }

  if (type === "authenticate") {
    const payload = verifyToken(msg.token || "");
    if (!payload) return ctx.reply({ ok: false, error: "Sessão expirada, faça login de novo." });
    const user = await findUserById(payload.sub);
    if (!user) return ctx.reply({ ok: false, error: "Usuário não encontrado." });
    ws.userId = user.id; ws.username = user.username;
    onlineByUsername.set(ws.username, ws);
    await touchLastSeen(user.id);
    ctx.reply({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: user.avatar_image || null, nickname: user.nickname || null, platformRole: user.platform_role || null } });
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
    // Capa principal escolhida já na criação (pedido explícito) — mesmo
    // campo/mecanismo do "trocar tema" que já existia no painel do dono,
    // só que preenchido de cara em vez de precisar editar depois.
    if (msg.coverImage && typeof msg.coverImage === "string" && msg.coverImage.length <= 1_900_000) {
      await updateClubCoverImage(club.id, msg.coverImage);
      club.cover_image = msg.coverImage;
    }
    // Foto de perfil do clube (diferente da capa) — mesmo mecanismo do
    // "update_club_image" que já existia pra trocar depois, só que
    // preenchido de cara quando o dono já manda uma na criação.
    if (msg.image && typeof msg.image === "string" && msg.image.length <= 1_900_000) {
      await updateClubImage(club.id, msg.image);
      club.image = msg.image;
    }
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
    // ID do agente que indicou — opcional. Um ID inválido não deve
    // travar o pedido de entrada, só não vincula a ninguém.
    let agentWalletId = null;
    if (msg.agentId) {
      const agentUser = await findUserById(Number(msg.agentId));
      if (agentUser) {
        const wallet = await getAgentWallet(club.id, agentUser.id);
        if (wallet && wallet.status === "active") agentWalletId = wallet.id;
      }
    }
    // Ainda não é membro — vira uma solicitação, o dono precisa aprovar
    // antes de dar acesso de verdade ao clube.
    await createJoinRequest(club.id, ws.userId, agentWalletId);
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
    // Limite de membros de acordo com o nível do clube (Clube Nível).
    const { membro: membroCap, level } = effectiveClubLevel(club);
    const currentCount = (await listMembers(club.id)).length;
    if (currentCount >= membroCap) {
      return ctx.reply({ ok: false, error: `Limite de membros do nível ${level} atingido (${membroCap}). Aumente o Clube Nível pra aceitar mais gente.` });
    }
    const pendingAgentWalletId = await getJoinRequestAgent(club.id, target.id);
    await addMember(club.id, target.id, 0, "member");
    await removeJoinRequest(club.id, target.id);
    if (pendingAgentWalletId) await linkMemberToAgent(club.id, target.id, pendingAgentWalletId, ws.userId);
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

  // Clube Nível — compra com diamante (do dono), vale 30 dias, aumenta a
  // capacidade de membros/gestores. Só o dono paga/decide (não abre pra
  // gestor, senão qualquer um gastaria o diamante de outra pessoa... na
  // real o diamante sai do próprio saldo de quem clica, então travamos
  // em "owner" só por clareza de quem é responsável pela assinatura).
  if (type === "buy_club_level") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || me.role !== "owner") return ctx.reply({ ok: false, error: "Só o dono do clube pode comprar o Clube Nível." });
    const level = Number(msg.level);
    const tier = CLUB_LEVEL_TIERS[level];
    if (!tier || level === 0) return ctx.reply({ ok: false, error: "Nível inválido." });
    const wallet = await getOrCreateQuickWallet(ws.userId);
    if (wallet.gems < tier.price) return ctx.reply({ ok: false, error: "Diamantes insuficientes." });
    await adjustQuickWalletGems(ws.userId, -tier.price);
    const expiresAt = await setClubLevel(club.id, level);
    ctx.reply({ ok: true, level, expiresAt, gems: wallet.gems - tier.price });
    return;
  }

  // Jackpot do clube — liga/desliga e define quanto % do rake do clube
  // (não do total, só da fatia que já seria dele) alimenta o pote.
  if (type === "set_jackpot_config") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Só o dono ou um gestor pode mexer no jackpot." });
    await setJackpotConfig(club.id, { enabled: !!msg.enabled, type: msg.jackpotType, feeMode: msg.feeMode });
    const fresh = await getClubById(club.id);
    // Devolve os campos atualizados na hora, na própria resposta — o
    // broadcastClub só alcança quem já tá com uma mesa desse clube
    // aberta (é indexado por runtime, não por "tá vendo o clube"), então
    // sozinho ele NÃO acorda a tela de Admin de quem acabou de mexer
    // no toggle. É por isso que ligar o jackpot não "pegava" antes.
    ctx.reply({ ok: true, jackpotEnabled: !!fresh.jackpot_enabled, jackpotBalance: Number(fresh.jackpot_balance || 0), jackpotType: fresh.jackpot_type, jackpotFeeMode: fresh.jackpot_fee_mode, jackpotRakePercent: Number(fresh.jackpot_rake_percent || 0) });
    await broadcastClub(club.code);
    refreshJackpotOnRuntimes(club.id);
    return;
  }

  // Injeta fichas do CAIXA do clube direto no pote do jackpot — desconta
  // da tesouraria normal (treasury_chips), nunca fabrica ficha do nada.
  if (type === "add_jackpot_chips") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Só o dono ou um gestor pode alimentar o jackpot." });
    const amount = Math.floor(Number(msg.amount) || 0);
    if (amount <= 0) return ctx.reply({ ok: false, error: "Quantidade inválida." });
    if (Number(club.treasury_chips) < amount) return ctx.reply({ ok: false, error: "Saldo do clube insuficiente." });
    await adjustClubTreasury(club.id, -amount);
    const newBalance = await addJackpotChips(club.id, amount);
    const freshClub = await getClubById(club.id);
    ctx.reply({ ok: true, jackpotBalance: newBalance, treasuryChips: Number(freshClub.treasury_chips) });
    await broadcastClub(club.code);
    refreshJackpotOnRuntimes(club.id);
    return;
  }

  // Promove/rebaixa um membro pra "gestor" (agent) — tem exatamente as
  // mesmas permissões do dono em todo o resto do sistema. Só o dono
  // mexe nisso (não deixa um gestor promover outro gestor à vontade).
  if (type === "set_member_role") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || me.role !== "owner") return ctx.reply({ ok: false, error: "Só o dono do clube pode promover/rebaixar gestor." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    const targetMember = await getMember(club.id, target.id);
    if (!targetMember) return ctx.reply({ ok: false, error: "Esse jogador não é membro do clube." });
    const role = msg.role === "agent" ? "agent" : "member";
    if (role === "agent") {
      const { gestor: gestorCap, level } = effectiveClubLevel(club);
      const currentAgents = (await listMembers(club.id)).filter((m) => m.role === "agent").length;
      if (currentAgents >= gestorCap) {
        return ctx.reply({ ok: false, error: `Limite de gestores do nível ${level} atingido (${gestorCap}). Aumente o Clube Nível pra ter mais gestores.` });
      }
    }
    await setMemberRole(club.id, target.id, role);
    ctx.reply({ ok: true });
    return;
  }

  // ============================================================
  // RAKE / RAKEBACK / AGENTE (comissão) / FECHAMENTO
  // ============================================================
  // "Agente" aqui é diferente do "Gestor" (role=agent) — só ganha
  // comissão sobre o rake da própria carteira, sem poder administrativo
  // nenhum. Só o DONO de verdade mexe em configuração financeira.
  const pctValid = (v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 100;

  if (type === "create_agent") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || me.role !== "owner") return ctx.reply({ ok: false, error: "Só o dono do clube pode criar agente." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    if (!(await getMember(club.id, target.id))) return ctx.reply({ ok: false, error: "Esse jogador não é membro do clube." });
    const { gestor: agentCap, level } = effectiveClubLevel(club);
    const activeAgents = (await listAgentWallets(club.id)).filter((a) => a.status === "active").length;
    if (activeAgents >= agentCap) {
      return ctx.reply({ ok: false, error: `Limite de agentes do nível ${level} atingido (${agentCap}). Aumente o Clube Nível pra ter mais agentes.` });
    }
    const rate = Number(msg.commissionRate ?? 0);
    if (!pctValid(rate)) return ctx.reply({ ok: false, error: "Comissão inválida (0 a 100)." });
    const agent = await createAgentWallet(club.id, target.id);
    await setCommissionRate(agent.id, rate, ws.userId);
    ctx.reply({ ok: true, agentWalletId: agent.id });
    return;
  }

  if (type === "set_agent_status") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || me.role !== "owner") return ctx.reply({ ok: false, error: "Só o dono do clube pode ativar/desativar agente." });
    const agent = await getAgentWalletById(msg.agentWalletId);
    if (!agent || agent.club_id !== club.id) return ctx.reply({ ok: false, error: "Agente não encontrado." });
    await setAgentStatus(agent.id, msg.status === "inactive" ? "inactive" : "active");
    ctx.reply({ ok: true });
    return;
  }

  if (type === "set_agent_commission") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || me.role !== "owner") return ctx.reply({ ok: false, error: "Só o dono do clube pode alterar a % de comissão." });
    const agent = await getAgentWalletById(msg.agentWalletId);
    if (!agent || agent.club_id !== club.id) return ctx.reply({ ok: false, error: "Agente não encontrado." });
    const rate = Number(msg.rate);
    if (!pctValid(rate)) return ctx.reply({ ok: false, error: "Comissão inválida (0 a 100)." });
    await setCommissionRate(agent.id, rate, ws.userId);
    ctx.reply({ ok: true });
    return;
  }

  // Pra tela de configuração poder mostrar o valor ATUAL antes de editar
  // (sem isso a caixinha aparecia sempre vazia, parecendo que nada tinha
  // sido salvo antes).
  if (type === "get_member_rakeback") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    const rate = await getCurrentRakebackRate(club.id, target.id);
    const link = await getCurrentAgentLink(club.id, target.id);
    ctx.reply({ ok: true, rate, agentWalletId: link?.agent_wallet_id || null });
    return;
  }

  if (type === "set_member_rakeback") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    const target = await findUserByUsername(msg.targetUsername);
    if (!target || !(await getMember(club.id, target.id))) return ctx.reply({ ok: false, error: "Membro não encontrado." });
    // Dono mexe no rakeback de qualquer um. Agente de RAKE só pode mexer
    // no rakeback de quem está vinculado a ELE — nunca em membro de fora
    // da própria carteira, e nunca cria/edita outro agente.
    if (!me || me.role !== "owner") {
      const myAgentWallet = await getAgentWallet(club.id, ws.userId);
      if (!myAgentWallet || myAgentWallet.status !== "active") return ctx.reply({ ok: false, error: "Sem permissão." });
      const link = await getCurrentAgentLink(club.id, target.id);
      if (!link || link.agent_wallet_id !== myAgentWallet.id) return ctx.reply({ ok: false, error: "Esse jogador não está na sua carteira." });
    }
    const rate = Number(msg.rate);
    if (!pctValid(rate)) return ctx.reply({ ok: false, error: "Rakeback inválido (0 a 100)." });
    await setRakebackRate(club.id, target.id, rate, ws.userId);
    ctx.reply({ ok: true });
    return;
  }

  if (type === "link_member_agent") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || me.role !== "owner") return ctx.reply({ ok: false, error: "Só o dono do clube pode vincular membro a agente." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target || !(await getMember(club.id, target.id))) return ctx.reply({ ok: false, error: "Membro não encontrado." });
    let agentWalletId = null;
    if (msg.agentWalletId) {
      const agent = await getAgentWalletById(msg.agentWalletId);
      if (!agent || agent.club_id !== club.id) return ctx.reply({ ok: false, error: "Agente não encontrado." });
      agentWalletId = agent.id;
    }
    await linkMemberToAgent(club.id, target.id, agentWalletId, ws.userId);
    ctx.reply({ ok: true });
    return;
  }

  if (type === "get_rake_dashboard") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão pra ver a Gestão de Rake." });
    const from = msg.from || new Date(0).toISOString();
    const to = msg.to || new Date().toISOString();
    const summary = await getRakeSummary(club.id, from, to);
    const agents = await getAgentRakeTable(club.id, from, to);
    const membersTable = await getMemberRakeTable(club.id, from, to);
    ctx.reply({ ok: true, summary, agents, members: membersTable });
    return;
  }

  // Painel do próprio agente — qualquer membro autenticado pode ver,
  // mas só enxerga a PRÓPRIA carteira (nunca a de outro agente).
  if (type === "get_my_agent_wallet") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const agent = await getAgentWallet(club.id, ws.userId);
    if (!agent) return ctx.reply({ ok: true, agent: null });
    const from = msg.from || new Date(0).toISOString();
    const to = msg.to || new Date().toISOString();
    const rate = await getCurrentCommissionRate(agent.id);
    const myMembers = await listAgentMembers(club.id, agent.id);
    const evs = await getAgentWalletSummary(club.id, agent.id, from, to);
    const membersWithRakeback = await Promise.all(myMembers.map(async (m) => ({
      username: m.username,
      rakebackRate: await getCurrentRakebackRate(club.id, m.member_user_id),
    })));
    ctx.reply({
      ok: true,
      agent: {
        id: agent.id, status: agent.status, commissionRate: rate, memberCount: myMembers.length,
        grossRake: Number(evs.gross), rakeback: Number(evs.rakeback), netBase: Number(evs.net),
        commission: Number(evs.commission), commissionPending: Number(evs.pending), commissionPaid: Number(evs.paid),
      },
      members: membersWithRakeback,
    });
    return;
  }

  if (type === "close_rake_period") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão pra fechar o período." });
    if (!msg.from || !msg.to) return ctx.reply({ ok: false, error: "Período inválido." });
    const { closing, eventCount } = await closeRakePeriod(club.id, msg.periodType || "custom", msg.from, msg.to, ws.userId);
    ctx.reply({ ok: true, closing, eventCount });
    return;
  }

  if (type === "list_rake_closings") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão pra ver fechamentos." });
    const closings = await listRakeClosings(club.id);
    ctx.reply({ ok: true, closings });
    return;
  }

  if (type === "get_rake_closing_detail") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const me = await getMember(club.id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão pra ver detalhe de fechamento." });
    const { closing, events } = await getRakeClosingDetail(msg.closingId);
    if (!closing || closing.club_id !== club.id) return ctx.reply({ ok: false, error: "Fechamento não encontrado." });
    ctx.reply({ ok: true, closing, events });
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
    let viewerIsOwner = me?.role === "owner" || me?.role === "agent";
    // Agente de RAKE também precisa ver o saldo do clube (é ele quem
    // envia ficha pros membros da própria carteira) — sem isso o "Saldo
    // do Clube" aparecia zerado pra ele mesmo o clube tendo saldo.
    if (!viewerIsOwner && me) {
      const myAgentWallet = await getAgentWallet(club.id, ws.userId);
      if (myAgentWallet && myAgentWallet.status === "active") viewerIsOwner = true;
    }
    const weeklyRake = viewerIsOwner ? await getWeeklyRake(club.id) : 0;
    const totalRake = viewerIsOwner ? await getTotalRake(club.id) : 0;
    const platformRake = viewerIsOwner ? await getTotalPlatformRake(club.id) : 0;
    ctx.reply({
      ok: true,
      club: publicClub(club, viewerIsOwner, { totalRake, platformRake }),
      members: membersForViewer(members, ws.username, viewerIsOwner),
      weeklyRake,
    });
    if (rt.table) send(ws, { type: "table_state", state: { ...rt.table.getPublicState(ws.username), tableName: rt.tableName || null, tableId: rt.tableId ?? null, jackpotEnabled: !!rt.jackpotEnabled, jackpotBalance: Number(rt.jackpotBalance || 0), autoStart: rt.autoStart !== false, minStartPlayers: rt.minStartPlayers || 2, chatBanned: !!rt.chatBanned } });
    return;
  }

  if (type === "adjust_chips") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false });
    const me = await getMember(club.id, ws.userId);
    // Agente de RAKE (não confundir com "Gestor", role=agent) também
    // pode enviar/retirar fichas — é ele quem paga os membros da própria
    // carteira. Só checa se precisar (evita consulta extra à toa).
    let isRakeSender = me && (me.role === "owner" || me.role === "agent");
    if (!isRakeSender && me) {
      const myAgentWallet = await getAgentWallet(club.id, ws.userId);
      isRakeSender = !!(myAgentWallet && myAgentWallet.status === "active");
    }
    if (!isRakeSender) return ctx.reply({ ok: false, error: "Sem permissão." });
    const target = await findUserByUsername(msg.targetUsername);
    if (!target) return ctx.reply({ ok: false, error: "Jogador não encontrado." });
    const delta = Number(msg.delta);
    const before = await getMember(club.id, target.id);
    const balanceBefore = before ? Number(before.chips) : 0;
    // Retirar (delta < 0): sai do jogador, volta pra tesouraria do clube —
    // não pode passar do que o jogador realmente tem. Sem essa checagem,
    // "retirar" de um jogador com saldo zerado inflava a tesouraria do
    // clube com fichas que nunca existiram de verdade.
    if (delta < 0 && balanceBefore < -delta) {
      return ctx.reply({ ok: false, error: "Esse jogador não tem fichas suficientes pra essa retirada." });
    }
    // Taxa do app de 5% — só no ENVIO (dono/gestor pra jogador), nunca
    // na retirada. Quem manda 2.000 quer que o jogador receba os 2.000
    // inteiros — quem PAGA a taxa é quem está mandando (100 a mais).
    const sendFee = delta > 0 ? Math.floor(delta * 0.05) : 0;
    // Gestor (role=agent, diferente do Agente de rake) nunca mexe na
    // tesouraria do clube — só o dono vê e controla o total de verdade.
    // O saldo que o Gestor movimenta é o PRÓPRIO (member.chips dele
    // mesmo) — o dono abastece esse saldo mandando fichas pra ele do
    // jeito normal (esse mesmo adjust_chips, como dono), e o Gestor
    // repassa de lá pros membros. Retirada que o Gestor faz de um
    // membro volta pro saldo PRÓPRIO dele (não pra tesouraria), já que
    // não foi de lá que saiu.
    const senderIsAgentRole = me.role === "agent";
    if (senderIsAgentRole) {
      const senderBefore = await getMember(club.id, ws.userId);
      const senderBalance = senderBefore ? Number(senderBefore.chips) : 0;
      if (delta > 0 && senderBalance < delta + sendFee) {
        return ctx.reply({ ok: false, error: "Seu saldo não cobre esse envio + a taxa de 5%." });
      }
      const chips = await adjustMemberChips(club.id, target.id, delta);
      // delta>0: sai do PRÓPRIO saldo (delta+taxa); delta<0 (retirada):
      // volta pro PRÓPRIO saldo (sem taxa).
      const senderChips = await adjustMemberChips(club.id, ws.userId, delta > 0 ? -(delta + sendFee) : -delta);
      if (sendFee > 0) await recordRake(club.id, 0, sendFee);
      await recordPayLedger({
        clubId: club.id, userId: target.id, adminId: ws.userId,
        type: delta >= 0 ? "send" : "withdraw",
        amount: Math.abs(delta), balanceBefore, balanceAfter: Number(chips),
      });
      ctx.reply({ ok: true, chips, fee: sendFee, senderChips: senderChips !== null ? Number(senderChips) : undefined });
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
    if (delta > 0 && Number(club.treasury_chips) < delta + sendFee) {
      return ctx.reply({ ok: false, error: "Saldo do clube insuficiente pra cobrir o envio + a taxa de 5%." });
    }
    const chips = await adjustMemberChips(club.id, target.id, delta);
    const treasuryChips = await adjustClubTreasury(club.id, -(delta + sendFee));
    if (sendFee > 0) await recordRake(club.id, 0, sendFee);
    await recordPayLedger({
      clubId: club.id, userId: target.id, adminId: ws.userId,
      type: delta >= 0 ? "send" : "withdraw",
      amount: Math.abs(delta), balanceBefore, balanceAfter: Number(chips),
    });
    ctx.reply({ ok: true, chips, treasuryChips, fee: sendFee });
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
    const me = await getMember(club.id, ws.userId);
    const viewerIsOwner = me?.role === "owner" || me?.role === "agent";
    const tables = await ensureDefaultClubTable(club);
    ctx.reply({
      ok: true,
      tables: tables
        // "Mesa exclusiva" some da lista pra quem não é dono/gestor —
        // é assim que uma mesa convite-only funciona de verdade, não só
        // uma etiqueta visual.
        .filter((t) => !t.exclusive || viewerIsOwner)
        .map((t) => {
        const trt = runtime.get(`${club.code}#${t.id}`);
        const players = trt?.table?.players || [];
        return {
          pendingBuyinCount: viewerIsOwner ? (trt?.pendingBuyins?.length || 0) : 0,
          id: t.id, name: t.name || null, variant: t.variant, smallBlind: t.small_blind, bigBlind: t.big_blind,
          buyIn: t.buy_in, maxBuyIn: t.max_buy_in ?? null, rakePercent: Number(t.rake_percent), maxPlayers: t.max_players,
          actionSeconds: t.action_seconds, durationMinutes: t.duration_minutes, autoExtend: t.auto_extend, autoExtendTimes: t.auto_extend_times,
          autoStart: t.auto_start, minStartPlayers: t.min_start_players, rakeCapBb: Number(t.rake_cap_bb),
          exclusive: !!t.exclusive, buyinRequiresApproval: !!t.buyin_requires_approval, chatBanned: !!t.chat_banned,
          showFoldedCards: t.show_folded_cards !== false, seeInAction: !!t.see_in_action, advancedFlags: t.advanced_flags || {},
          playersNow: players.length,
          // Pra tela de prévia da mesa (quem tá jogando) e pra saber se o
          // próprio jogador já está sentado ali (mostra "voltar a jogar"
          // em vez de "sentar" de novo — sem isso, tentar sentar de novo
          // cobrava outro buy-in sem nem colocar a pessoa de volta).
          seatedPlayers: players.map((p) => p.name),
          viewerIsSeated: players.some((p) => p.id === ws.username),
        };
      }),
    });
    return;
  }

  // Lê e valida tudo que a tela "Criar mesa" manda além do básico
  // (blinds/buy-in/rake/max) — compartilhado entre criar e editar pra
  // não duplicar a validação.
  function parseAdvancedTableFields(msg) {
    return {
      name: (msg.name || "").trim().slice(0, 40) || null,
      actionSeconds: Math.min(60, Math.max(5, Number(msg.actionSeconds) || 30)),
      maxBuyIn: msg.maxBuyIn != null ? Math.max(0, Number(msg.maxBuyIn) || 0) : null,
      durationMinutes: Math.max(0, Number(msg.durationMinutes) || 0),
      autoExtend: !!msg.autoExtend,
      autoExtendTimes: Math.max(0, Math.min(50, Number(msg.autoExtendTimes) || 0)),
      autoStart: msg.autoStart !== false,
      minStartPlayers: Math.max(2, Math.min(9, Number(msg.minStartPlayers) || 2)),
      rakeCapBb: Math.max(0, Math.min(20, Number(msg.rakeCapBb) || 3)),
      exclusive: !!msg.exclusive,
      buyinRequiresApproval: !!msg.buyinRequiresApproval,
      chatBanned: !!msg.chatBanned,
      showFoldedCards: msg.showFoldedCards !== false,
      seeInAction: !!msg.seeInAction,
      advancedFlags: msg.advancedFlags && typeof msg.advancedFlags === "object" ? msg.advancedFlags : {},
    };
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
    const t = await createClubTable({ clubId: club.id, variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers, ...parseAdvancedTableFields(msg) });
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
    await updateClubTable(club.id, existing.id, { variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers, ...parseAdvancedTableFields(msg) });
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
    const me = await getMember(club.id, ws.userId);
    const viewerIsOwner = me?.role === "owner" || me?.role === "agent";
    const list = (await listClubTournaments(club.id))
      // "Mesa exclusiva" some da lista pra quem não é dono/gestor —
      // igual já funciona pra mesa cash.
      .filter((t) => !(t.advanced_flags || {}).exclusive || viewerIsOwner);
    const withCounts = await Promise.all(list.map(async (t) => {
      const entries = await listTournamentEntries(t.id);
      const mine = entries.find((e) => e.user_id === ws.userId);
      const pub = publicTournament(t, entries, mine, ws.username);
      pub.pendingRegCount = viewerIsOwner ? (tournamentPendingRegs.get(t.id) || []).length : 0;
      return pub;
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
    if (!BLIND_STRUCTURES[msg.blindStructure]) return ctx.reply({ ok: false, error: "Estrutura de blind inválida." });
    const name = String(msg.name || "").trim().slice(0, 60) || "Torneio sem nome";
    const buyIn = Math.max(0, Number(msg.buyIn) || 0);
    const startingChips = Math.max(100, Number(msg.startingChips) || 10000);
    // "Máx. de jogadores: 7.000" — igual ao limite do pppoker (a versão
    // antiga travava em 90, um resquício de quando torneio só rodava
    // numa única mesa cheia).
    const maxPlayers = Math.min(7000, Math.max(2, Number(msg.maxPlayers) || 90));
    const minPlayers = Math.min(maxPlayers, Math.max(2, Number(msg.minPlayers) || 2));
    const lateRegMinutes = Math.max(0, Number(msg.lateRegMinutes) || 0);
    // Registro tardio por NÍVEL de blind (alternativa ao "por minutos"
    // que já existia) — igual o "Reg. tardio: Nível de blind X" do
    // pppoker. Quando preenchido, register_tournament confere por nível
    // em vez de por tempo corrido.
    const lateRegLevel = msg.lateRegLevel != null ? Math.max(0, Number(msg.lateRegLevel) || 0) : null;
    const rebuyAllowed = !!msg.rebuyAllowed;
    const rebuyMax = rebuyAllowed ? Math.max(1, Number(msg.rebuyMax) || 1) : 0;
    // Rebuy: multiplicador (1.0x-3.0x) escala tanto o preço quanto as
    // fichas iniciais; Duplo/Triplo escalam por cima disso de novo — o
    // jogador paga N vezes o preço do rebuy e recebe N vezes as fichas.
    const rebuyMultiplier = rebuyAllowed ? Math.min(3, Math.max(1, Number(msg.rebuyMultiplier) || 1)) : 1;
    const rebuyDouble = rebuyAllowed && !!msg.rebuyDouble;
    const rebuyTriple = rebuyAllowed && !rebuyDouble && !!msg.rebuyTriple;
    const addonEnabled = !!msg.addonEnabled;
    const addonMultiplier = addonEnabled ? Math.min(3, Math.max(1, Number(msg.addonMultiplier) || 1)) : 1;
    const addonDouble = addonEnabled && !!msg.addonDouble;
    const addonTriple = addonEnabled && !addonDouble && !!msg.addonTriple;
    const addonPauseMinutes = Math.min(30, Math.max(1, Number(msg.addonPauseMinutes) || 5));
    // K.O.: "off" (desligado) | "regular" | "progressive" | "mystery".
    const koMode = ["off", "regular", "progressive", "mystery"].includes(msg.koMode) ? msg.koMode : "regular";
    const itmMode = msg.itmMode === "players" ? "players" : "buyins";
    const payoutWeighting = ["flat", "standard", "aggressive"].includes(msg.payoutWeighting) ? msg.payoutWeighting : "standard";
    // "Personalizar>>" — tabela de níveis fixa, cada um {sb,bb,ante}.
    // Validado com cuidado porque entra direto na fórmula de blind do
    // torneio inteiro — um nível malformado travaria todo mundo.
    let customBlindLevels = null;
    if (Array.isArray(msg.customBlindLevels) && msg.customBlindLevels.length > 0) {
      customBlindLevels = msg.customBlindLevels.slice(0, 60).map((lvl) => ({
        sb: Math.max(0, Number(lvl?.sb) || 0), bb: Math.max(0, Number(lvl?.bb) || 0), ante: Math.max(0, Number(lvl?.ante) || 0),
      })).filter((lvl) => lvl.bb > 0);
      if (customBlindLevels.length === 0) customBlindLevels = null;
    }
    // Opções avançadas (mesa exclusiva, registro autorizado, banir
    // chat, ver cartas descartadas, restrições, MTT recorrente, limite
    // de Time Bank, Multi-Dias) — mesmo padrão de club_tables, tudo
    // dentro de advanced_flags (JSONB) por simplicidade.
    const advancedFlags = msg.advancedFlags && typeof msg.advancedFlags === "object" ? msg.advancedFlags : {};
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
    // Early Bird: desconto no buy-in pra quem se inscrever até X horas
    // antes do início — guardamos já como um horário-limite fixo (mais
    // fácil de checar depois do que recalcular "X horas antes" toda vez).
    const earlyBirdDiscountPct = Math.min(90, Math.max(0, Number(msg.earlyBirdDiscountPct) || 0));
    const earlyBirdHours = Math.max(0, Number(msg.earlyBirdHours) || 0);
    const earlyBirdDeadline = earlyBirdDiscountPct > 0 && earlyBirdHours > 0
      ? new Date(startTime.getTime() - earlyBirdHours * 3600000).toISOString()
      : null;
    // Bônus de fichas iniciais do Early Bird — válido até o nível de
    // blind escolhido (não até o mesmo horário-limite do desconto,
    // porque o pppoker descreve esse bônus por NÍVEL, não por horário).
    const earlyBirdChipBonusPct = Math.min(200, Math.max(0, Number(msg.earlyBirdChipBonusPct) || 0));
    const earlyBirdChipBonusLevel = earlyBirdChipBonusPct > 0 ? Math.max(1, Number(msg.earlyBirdChipBonusLevel) || 1) : 0;
    const bountyEnabled = !!msg.bountyEnabled;
    const bountyPercent = bountyEnabled ? Math.min(90, Math.max(1, Number(msg.bountyPercent) || 50)) : 0;
    // Aceita fração (12.5%) — igual as opções do pppoker (5/10/12.5/15/20).
    const payoutPercent = Math.min(50, Math.max(5, Number(msg.payoutPercent) || 12));
    const t = await createTournament({
      clubId: club.id, name, variant, buyIn, startingChips, maxPlayers, minPlayers,
      blindStructure: msg.blindStructure, levelMinutes: BLIND_STRUCTURES[msg.blindStructure].levelMinutes,
      lateRegMinutes, rebuyAllowed, rebuyMax, gtdPrize, startTime: startTime.toISOString(), createdBy: ws.userId,
      earlyBirdDiscountPct, earlyBirdDeadline, bountyEnabled, bountyPercent, payoutPercent,
      rebuyMultiplier, rebuyDouble, rebuyTriple, addonEnabled, addonMultiplier, addonDouble, addonTriple, addonPauseMinutes,
      koMode, itmMode, payoutWeighting, earlyBirdChipBonusPct, earlyBirdChipBonusLevel, lateRegLevel,
      customBlindLevels, advancedFlags,
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
      tournament: publicTournament(t, entries, mine, ws.username),
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
      // Registro tardio por NÍVEL de blind, quando configurado assim na
      // criação — tem prioridade sobre o "por minutos" de baixo.
      if (t.late_reg_level != null) {
        if (Number(t.current_level || 0) > Number(t.late_reg_level)) {
          return ctx.reply({ ok: false, error: "Inscrição tardia já encerrou." });
        }
      } else {
        // Aproximação razoável: inscrição tardia conta a partir do início
        // do torneio, não do nível atual — usamos created_at como início.
        const tournamentStartedAt = new Date(t.start_time).getTime();
        if (Date.now() > tournamentStartedAt + Number(t.late_reg_minutes) * 60000) {
          return ctx.reply({ ok: false, error: "Inscrição tardia já encerrou." });
        }
      }
    }
    const existing = await getTournamentEntry(t.id, ws.userId);
    if (existing) return ctx.reply({ ok: false, error: "Você já está inscrito nesse torneio." });
    const entries = await listTournamentEntries(t.id);
    const activeCount = entries.filter((e) => e.status !== "cancelled").length;
    if (activeCount >= t.max_players) return ctx.reply({ ok: false, error: "Torneio lotado." });
    const flags = t.advanced_flags || {};
    // "Restrição de IP": ninguém com o mesmo IP de quem já está
    // inscrito nesse torneio consegue se inscrever também.
    if (flags.ipRestriction && ws.remoteIp) {
      const list = tournamentRegCoords.get(t.id) || [];
      if (list.some((r) => r.userId !== ws.userId && r.ip && r.ip === ws.remoteIp)) {
        return ctx.reply({ ok: false, error: "Restrição de IP: já tem alguém com esse mesmo IP inscrito nesse torneio." });
      }
    }
    // "Restrição de GPS": exige lat/lng do cliente e recusa se tiver
    // alguém inscrito mais perto que o mínimo configurado.
    if (flags.gpsRestriction) {
      const minMeters = Number(flags.gpsMinMeters) || 100;
      if (!(msg.lat != null && msg.lng != null)) {
        return ctx.reply({ ok: false, error: "Esse torneio exige localização pra se inscrever — ative o GPS e tenta de novo." });
      }
      const list = tournamentRegCoords.get(t.id) || [];
      for (const r of list) {
        if (r.userId === ws.userId || r.lat == null) continue;
        if (haversineMeters(msg.lat, msg.lng, r.lat, r.lng) < minMeters) {
          return ctx.reply({ ok: false, error: "Restrição de GPS: tem alguém inscrito perto demais desse torneio." });
        }
      }
    }
    // Early Bird: desconto no buy-in pra quem se inscrever antes do
    // prazo-limite guardado na criação do torneio.
    const earlyBirdActive = t.early_bird_deadline && Date.now() < new Date(t.early_bird_deadline).getTime();
    const chargedBuyIn = earlyBirdActive
      ? Math.round(Number(t.buy_in) * (1 - Number(t.early_bird_discount_pct) / 100))
      : Number(t.buy_in);
    const member = await getMember(t.club_id, ws.userId);
    if (!member || Number(member.chips) < chargedBuyIn) return ctx.reply({ ok: false, error: "Saldo insuficiente pra esse buy-in." });
    // "Registro autorizado": em vez de sentar direto, entra numa fila
    // pro dono/gestor aprovar — não cobra nada até ser aprovado.
    if (flags.registrationApproval) {
      const me = await getMember(t.club_id, ws.userId);
      const isAdmin = me && (me.role === "owner" || me.role === "agent");
      if (!isAdmin) {
        const list = tournamentPendingRegs.get(t.id) || [];
        if (list.some((r) => r.userId === ws.userId)) return ctx.reply({ ok: false, error: "Seu pedido já está aguardando aprovação." });
        list.push({ userId: ws.userId, username: ws.username, avatar: member.avatar, requestedAt: Date.now() });
        tournamentPendingRegs.set(t.id, list);
        ctx.reply({ ok: true, pendingApproval: true });
        return;
      }
    }
    // Bônus de fichas iniciais do Early Bird — vale até o nível de blind
    // configurado (independe do prazo do desconto, que é por horário).
    const chipBonusActive = Number(t.early_bird_chip_bonus_pct || 0) > 0
      && Number(t.current_level || 0) <= Number(t.early_bird_chip_bonus_level || 0);
    const grantedChips = chipBonusActive
      ? Math.round(Number(t.starting_chips) * (1 + Number(t.early_bird_chip_bonus_pct) / 100))
      : Number(t.starting_chips);
    await adjustMemberChips(t.club_id, ws.userId, -chargedBuyIn);
    await adjustClubTreasury(t.club_id, chargedBuyIn);
    await addTournamentEntry(t.id, ws.userId, grantedChips, chargedBuyIn);
    // K.O. Progressivo: semeia o pote próprio do jogador com o valor
    // cheio do bounty — cresce a partir daqui a cada eliminação que ele
    // fizer (ver payKnockoutBounty).
    if (t.bounty_enabled && t.ko_mode === "progressive") {
      const seed = Math.round(Number(t.buy_in) * Number(t.bounty_percent) / 100);
      if (seed > 0) await updateTournamentEntry(t.id, ws.userId, { bounty_pool: seed });
    }
    if (flags.ipRestriction || flags.gpsRestriction) {
      const list = tournamentRegCoords.get(t.id) || [];
      list.push({ userId: ws.userId, ip: ws.remoteIp || null, lat: msg.lat ?? null, lng: msg.lng ?? null });
      tournamentRegCoords.set(t.id, list);
    }
    // Carreira: registra o buy-in pago como perda (fichas REAIS do clube,
    // não a pilha de fichas do torneio — essa é só um número interno do
    // jogo, não corresponde a dinheiro de verdade).
    await recordHandLedger(t.club_id, null, ws.userId, -chargedBuyIn);
    ctx.reply({ ok: true, earlyBird: earlyBirdActive, charged: chargedBuyIn, chipBonus: chipBonusActive, chips: grantedChips });
    return;
  }

  if (type === "list_tournament_registration_requests") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    const me = await getMember(t.club_id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const list = tournamentPendingRegs.get(t.id) || [];
    ctx.reply({ ok: true, requests: list.map((r) => ({ username: r.username, avatar: r.avatar })) });
    return;
  }

  if (type === "approve_tournament_registration") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    const me = await getMember(t.club_id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const list = tournamentPendingRegs.get(t.id) || [];
    const idx = list.findIndex((r) => r.username === msg.username);
    if (idx === -1) return ctx.reply({ ok: false, error: "Pedido não encontrado (talvez já tenha expirado)." });
    const [req] = list.splice(idx, 1);
    tournamentPendingRegs.set(t.id, list);
    const member = await getMember(t.club_id, req.userId);
    const chargedBuyIn = t.early_bird_deadline && Date.now() < new Date(t.early_bird_deadline).getTime()
      ? Math.round(Number(t.buy_in) * (1 - Number(t.early_bird_discount_pct) / 100)) : Number(t.buy_in);
    if (!member || Number(member.chips) < chargedBuyIn) {
      pushToUser(req.userId, { type: "toast", message: "Seu pedido foi aprovado, mas seu saldo caiu abaixo do buy-in — não deu pra confirmar a inscrição." });
      return ctx.reply({ ok: false, error: "Saldo do jogador ficou insuficiente nesse meio-tempo." });
    }
    await adjustMemberChips(t.club_id, req.userId, -chargedBuyIn);
    await adjustClubTreasury(t.club_id, chargedBuyIn);
    await addTournamentEntry(t.id, req.userId, Number(t.starting_chips), chargedBuyIn);
    if (t.bounty_enabled && t.ko_mode === "progressive") {
      const seed = Math.round(Number(t.buy_in) * Number(t.bounty_percent) / 100);
      if (seed > 0) await updateTournamentEntry(t.id, req.userId, { bounty_pool: seed });
    }
    await recordHandLedger(t.club_id, null, req.userId, -chargedBuyIn);
    pushToUser(req.userId, { type: "toast", message: `Sua inscrição em "${t.name}" foi aprovada.` });
    ctx.reply({ ok: true });
    return;
  }

  if (type === "decline_tournament_registration") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    const me = await getMember(t.club_id, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    const list = tournamentPendingRegs.get(t.id) || [];
    const idx = list.findIndex((r) => r.username === msg.username);
    if (idx !== -1) {
      const [req] = list.splice(idx, 1);
      tournamentPendingRegs.set(t.id, list);
      pushToUser(req.userId, { type: "toast", message: `Sua inscrição em "${t.name}" foi recusada.` });
    }
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
    const refundAmount = Number(existing.buy_in_paid ?? existing.chips);
    await adjustMemberChips(t.club_id, ws.userId, refundAmount);
    await adjustClubTreasury(t.club_id, -refundAmount);
    await removeTournamentEntry(t.id, ws.userId);
    const coordList = tournamentRegCoords.get(t.id);
    if (coordList) tournamentRegCoords.set(t.id, coordList.filter((r) => r.userId !== ws.userId));
    const pendingList = tournamentPendingRegs.get(t.id);
    if (pendingList) tournamentPendingRegs.set(t.id, pendingList.filter((r) => r.userId !== ws.userId));
    // Desfaz o -buyIn que tinha sido registrado na carreira ao se inscrever.
    await recordHandLedger(t.club_id, null, ws.userId, refundAmount);
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
      const refundAmount = Number(e.buy_in_paid ?? e.chips);
      await adjustMemberChips(t.club_id, e.user_id, refundAmount);
      await adjustClubTreasury(t.club_id, -refundAmount);
      await updateTournamentEntry(t.id, e.user_id, { status: "cancelled" });
      await recordHandLedger(t.club_id, null, e.user_id, refundAmount);
    }
    await updateTournament(t.id, { status: "cancelled" });
    ctx.reply({ ok: true });
    return;
  }

  // Voltar pra uma mesa em que já está sentado (o cliente perdeu a
  // conexão/navegou pra outro lugar sem "Sair da mesa" de verdade) — só
  // reconecta o socket, NUNCA cobra buy-in de novo. Sem isso, quem
  // saísse da tela sem clicar em "Sair da mesa" ficava preso: tentar
  // "Sentar" de novo cobrava outro buy-in do saldo pessoal (que já
  // tinha sido gasto na primeira vez) e travava sem conseguir voltar.
  // Handler genérico de "estou vendo essa mesa, me manda as atualizações" —
  // cobre TODO caminho que leva a uma tela de mesa sem passar por
  // sit_table (reconectar depois de queda, entrar via "Entrar na minha
  // mesa" do torneio, clicar na barra de mesas ativas). Sem isso o socket
  // nunca entra em rt.socketToPlayer e a mesa fica "Abrindo a mesa…" pra
  // sempre, mesmo com o jogador de verdade sentado nela. Só reconecta —
  // nunca senta, nunca cobra buy-in; se o jogador não estiver mesmo
  // sentado ali, recusa.
  if (type === "watch_table") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table || !rt.table.players.some((p) => p.id === ws.username)) {
      return ctx.reply({ ok: false, error: "Você não está sentado nessa mesa." });
    }
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode?.(code);
    ctx.reply({ ok: true, code });
    broadcastTable(code);
    return;
  }

  if (type === "rejoin_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const code = `${club.code}#${Number(msg.tableId)}`;
    const rt = runtime.get(code);
    if (!rt?.table || !rt.table.players.some((p) => p.id === ws.username)) {
      return ctx.reply({ ok: false, error: "Você não está sentado nessa mesa." });
    }
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
    broadcastTable(code);
    return;
  }

  // Entra na mesa como ESPECTADOR — sem sentar, sem pedir buy-in. É pra
  // "entrar de verdade no ambiente" antes de decidir jogar, em vez de um
  // popup por cima com uma lista. A mesa (e o resto de quem já estiver
  // jogando) fica visível ao vivo; sentar de verdade é uma ação separada
  // (sit_club_table), disparada de dentro dessa mesma tela.
  if (type === "spectate_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const t = await getClubTableById(club.id, Number(msg.tableId));
    if (!t) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const code = `${club.code}#${t.id}`;
    const rt = ensureRuntime(code, club.id);
    if (!rt.table) rt.table = new PokerTable({ smallBlind: t.small_blind, bigBlind: t.big_blind, rakePercent: Number(t.rake_percent), variant: t.variant, maxSeats: t.max_players, rakeCapBb: Number(t.rake_cap_bb ?? 3), actionSeconds: t.action_seconds || 30, revealFoldedCards: t.show_folded_cards !== false,
      seeInAction: !!t.see_in_action, straddleEnabled: !!(t.advanced_flags || {}).straddle, runItMultiple: !!(t.advanced_flags || {}).runItMultiple, splitEv: !!(t.advanced_flags || {}).splitEv });
    setupTableDuration(rt, t);;
    rt.tableName = t.name; rt.tableId = t.id;
    rt.jackpotEnabled = !!club.jackpot_enabled; rt.jackpotBalance = Number(club.jackpot_balance || 0);
    rt.autoStart = t.auto_start !== false; rt.minStartPlayers = t.min_start_players || 2; rt.chatBanned = !!t.chat_banned;
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
    broadcastTable(code);
    return;
  }

  // CAPTCHA local (sem serviço externo, sem credencial nenhuma) — uma
  // continha simples de somar dois números pequenos. Guardada no
  // próprio socket, expira em 2 minutos.
  if (type === "request_table_captcha") {
    if (!requireAuth(ws, ctx)) return;
    const a = 2 + Math.floor(Math.random() * 8);
    const b = 2 + Math.floor(Math.random() * 8);
    ws.pendingCaptcha = { code: (msg.code || "").toUpperCase(), answer: a + b, expires: Date.now() + 120000 };
    ctx.reply({ ok: true, question: `${a} + ${b}` });
    return;
  }

  if (type === "sit_club_table") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const t = await getClubTableById(club.id, Number(msg.tableId));
    if (!t) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const code = `${club.code}#${t.id}`;
    // Proteção extra: se por algum motivo o cliente chamar "sentar" de
    // novo enquanto a pessoa JÁ está sentada ali (não devia acontecer
    // com a tela nova, mas evita cobrar buy-in duas vezes se acontecer),
    // só reconecta em vez de tentar sentar de novo.
    const existingRt = runtime.get(code);
    if (existingRt?.table?.players?.some((p) => p.id === ws.username)) {
      existingRt.sockets.add(ws);
      existingRt.socketToPlayer.set(ws, ws.username);
      ctx.setJoinedCode(code);
      ctx.reply({ ok: true, code });
      broadcastTable(code);
      return;
    }
    const member = await getMember(club.id, ws.userId);
    const minBuyIn = t.buy_in;
    const maxBuyIn = t.max_buy_in || t.buy_in * 4;
    if (!member || Number(member.chips) < minBuyIn) return ctx.reply({ ok: false, error: "Royalle Pay insuficiente." });
    // High Roller: só quem já tem o saldo mínimo configurado pode sentar.
    const flags = t.advanced_flags || {};
    if (flags.highRoller && Number(member.chips) < Number(flags.highRollerMin || 0)) {
      return ctx.reply({ ok: false, error: `Mesa High Roller — saldo mínimo de ${Number(flags.highRollerMin || 0).toLocaleString("pt-BR")} pra entrar.` });
    }
    const buyIn = Math.min(maxBuyIn, Math.max(minBuyIn, Number(msg.buyIn) || minBuyIn), Number(member.chips));
    // "Restrição de IP": ninguém com o mesmo IP de quem já tá sentado
    // consegue sentar — olha os sockets realmente conectados nessa mesa
    // agora (rt.socketToPlayer), não algum cadastro antigo.
    if (flags.ipRestriction && ws.remoteIp) {
      const rtCheck = runtime.get(code);
      if (rtCheck?.socketToPlayer) {
        for (const otherWs of rtCheck.socketToPlayer.keys()) {
          if (otherWs !== ws && otherWs.remoteIp && otherWs.remoteIp === ws.remoteIp) {
            return ctx.reply({ ok: false, error: "Restrição de IP: já tem alguém com esse mesmo IP sentado nessa mesa." });
          }
        }
      }
    }
    // "Restrição de GPS": exige lat/lng do cliente (pedido de permissão
    // já é feito no app antes de mandar sit_club_table) e recusa se
    // tiver alguém sentado mais perto que o mínimo configurado.
    if (flags.gpsRestriction) {
      const minMeters = Number(flags.gpsMinMeters) || 100;
      if (!(msg.lat != null && msg.lng != null)) {
        return ctx.reply({ ok: false, error: "Essa mesa exige localização pra sentar — ative o GPS e tenta de novo." });
      }
      const rtCheck = runtime.get(code);
      const seatedCoords = rtCheck?.seatedCoords || {};
      for (const [otherUsername, coord] of Object.entries(seatedCoords)) {
        if (otherUsername === ws.username) continue;
        const meters = haversineMeters(msg.lat, msg.lng, coord.lat, coord.lng);
        if (meters < minMeters) {
          return ctx.reply({ ok: false, error: "Restrição de GPS: tem alguém sentado perto demais dessa mesa." });
        }
      }
    }
    // CAPTCHA: precisa ter pedido a continha (request_table_captcha)
    // pra essa mesma mesa e mandado a resposta certa dentro de 2min. Se
    // falhar, a regra oficial remove da mesa e não deixa voltar — aqui
    // só recusa a entrada mesmo (não tem "mesa" pra remover ainda).
    if (flags.captcha) {
      const pc = ws.pendingCaptcha;
      if (!pc || pc.code !== code || Date.now() > pc.expires) {
        return ctx.reply({ ok: false, error: "Resolve o CAPTCHA antes de sentar.", needsCaptcha: true });
      }
      if (Number(msg.captchaAnswer) !== pc.answer) {
        ws.pendingCaptcha = null;
        return ctx.reply({ ok: false, error: "CAPTCHA errado — tenta de novo.", needsCaptcha: true });
      }
      ws.pendingCaptcha = null;
    }
    // "Autorizado a fazer buy-in": em vez de sentar na hora, vira um
    // pedido que o dono/gestor precisa aprovar — guardado na própria
    // mesa em memória (mesa é algo efêmero, não precisa sobreviver a um
    // restart do servidor pra isso fazer sentido).
    async function isAdminOfClub() {
      const meMember = member; // já temos os dados de member acima
      return meMember?.role === "owner" || meMember?.role === "agent";
    }
    if (t.buyin_requires_approval && !(await isAdminOfClub())) {
      const rtPending = ensureQuickRuntime(code, t.variant, null);
      rtPending.isQuick = false; rtPending.clubId = club.id; rtPending.clubCode = club.code;
      rtPending.tableName = t.name; rtPending.tableId = t.id;
      rtPending.pendingBuyins = rtPending.pendingBuyins || [];
      if (rtPending.pendingBuyins.some((r) => r.username === ws.username)) {
        return ctx.reply({ ok: false, pending: true, error: "Seu pedido de buy-in já está aguardando aprovação." });
      }
      rtPending.pendingBuyins.push({ username: ws.username, userId: ws.userId, buyIn, seat: Number.isInteger(msg.seat) ? msg.seat : null, avatar: member.avatar, at: Date.now() });
      ctx.reply({ ok: true, pending: true });
      // Avisa quem pode aprovar (dono/gestores online) pra não ficar
      // esperando sem saber que tem pedido — mesma ideia do
      // table_assigned de torneio.
      const admins = (await listMembers(club.id)).filter((m) => m.role === "owner" || m.role === "agent");
      for (const a of admins) pushToUser(a.username, { type: "buyin_requested", code, username: ws.username });
      return;
    }
    await adjustMemberChips(club.id, ws.userId, -buyIn);
    const rt = ensureQuickRuntime(code, t.variant, null);
    rt.isQuick = false; // usa carteira de clube (Royalle Pay), não a avulsa
    rt.clubId = club.id;
    rt.clubCode = club.code;
    rt.tableName = t.name; rt.tableId = t.id;
    rt.jackpotEnabled = !!club.jackpot_enabled; rt.jackpotBalance = Number(club.jackpot_balance || 0);
    rt.autoStart = t.auto_start !== false; rt.minStartPlayers = t.min_start_players || 2; rt.chatBanned = !!t.chat_banned;
    if (!rt.table) rt.table = new PokerTable({ smallBlind: t.small_blind, bigBlind: t.big_blind, rakePercent: Number(t.rake_percent), variant: t.variant, maxSeats: t.max_players, rakeCapBb: Number(t.rake_cap_bb ?? 3), actionSeconds: t.action_seconds || 30, revealFoldedCards: t.show_folded_cards !== false,
      seeInAction: !!t.see_in_action, straddleEnabled: !!(t.advanced_flags || {}).straddle, runItMultiple: !!(t.advanced_flags || {}).runItMultiple, splitEv: !!(t.advanced_flags || {}).splitEv });
    setupTableDuration(rt, t);;
    rt.table.addPlayer(ws.username, ws.username, buyIn, false, Number.isInteger(msg.seat) ? msg.seat : null);
    recordSessionBuyIn(rt.table, ws.username, buyIn);
    if (flags.gpsRestriction && msg.lat != null && msg.lng != null) {
      rt.seatedCoords = rt.seatedCoords || {};
      rt.seatedCoords[ws.username] = { lat: msg.lat, lng: msg.lng };
    }
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
    broadcastTable(code);
    return;
  }

  // Lista os pedidos de buy-in pendentes dessa mesa (só dono/gestor).
  if (type === "list_table_buyin_requests") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.clubId) return ctx.reply({ ok: true, requests: [] });
    const me = await getMember(rt.clubId, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    ctx.reply({ ok: true, requests: (rt.pendingBuyins || []).map((r) => ({ username: r.username, buyIn: r.buyIn, avatar: r.avatar })) });
    return;
  }

  if (type === "approve_table_buyin" || type === "reject_table_buyin") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.clubId) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const me = await getMember(rt.clubId, ws.userId);
    if (!me || (me.role !== "owner" && me.role !== "agent")) return ctx.reply({ ok: false, error: "Sem permissão." });
    rt.pendingBuyins = rt.pendingBuyins || [];
    const idx = rt.pendingBuyins.findIndex((r) => r.username === msg.username);
    if (idx === -1) return ctx.reply({ ok: false, error: "Pedido não encontrado (já foi decidido?)." });
    const [req] = rt.pendingBuyins.splice(idx, 1);
    if (type === "reject_table_buyin") {
      pushToUser(req.username, { type: "buyin_rejected", code });
      ctx.reply({ ok: true });
      return;
    }
    // Aprovado: só agora debita e senta de verdade — o pedido em si
    // nunca reservou ficha nenhuma, pra não travar dinheiro da pessoa
    // enquanto espera uma resposta que pode nunca vir.
    const member = await getMember(rt.clubId, req.userId);
    if (!member || Number(member.chips) < req.buyIn) {
      pushToUser(req.username, { type: "buyin_rejected", code, reason: "insufficient" });
      return ctx.reply({ ok: false, error: "Jogador não tem mais saldo suficiente." });
    }
    await adjustMemberChips(rt.clubId, req.userId, -req.buyIn);
    if (!rt.table) {
      const t = await getClubTableById(rt.clubId, rt.tableId);
      if (t) rt.table = new PokerTable({ smallBlind: t.small_blind, bigBlind: t.big_blind, rakePercent: Number(t.rake_percent), variant: t.variant, maxSeats: t.max_players, rakeCapBb: Number(t.rake_cap_bb ?? 3), actionSeconds: t.action_seconds || 30, revealFoldedCards: t.show_folded_cards !== false,
      seeInAction: !!t.see_in_action, straddleEnabled: !!(t.advanced_flags || {}).straddle, runItMultiple: !!(t.advanced_flags || {}).runItMultiple, splitEv: !!(t.advanced_flags || {}).splitEv });
    setupTableDuration(rt, t);;
    }
    if (rt.table) {
      rt.table.addPlayer(req.username, req.username, req.buyIn, false, req.seat);
      recordSessionBuyIn(rt.table, req.username, req.buyIn);
    }
    pushToUser(req.username, { type: "buyin_approved", code });
    ctx.reply({ ok: true });
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
    recordSessionBuyIn(rt.table, ws.username, msg.buyIn);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.reply({ ok: true });
    await broadcastClub(club.code);
    broadcastTable(club.code);
    return;
  }

  if (type === "add_chips_at_table") {
    // Recompra ("Mais Fichas" no menu ☰ da mesa) — o frontend já chamava
    // esse tipo de mensagem há tempos, só que ele nunca existiu aqui no
    // servidor, então todo pedido de recompra sempre voltava com erro.
    // Cobre tanto mesa de clube (rt.clubId, débito na carteira do
    // clube) quanto mesa pública (rt.isQuick, débito na carteira avulsa).
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const player = rt.table.players.find((p) => p.id === ws.username);
    if (!player) return ctx.reply({ ok: false, error: "Você não está sentado nessa mesa." });
    if (rt.table.stage !== "idle" && rt.table.stage !== "showdown") {
      return ctx.reply({ ok: false, error: "Só dá pra recomprar fora de uma mão em andamento." });
    }
    const amount = Math.floor(Number(msg.amount) || 0);
    if (amount <= 0) return ctx.reply({ ok: false, error: "Quantidade inválida." });
    if (rt.clubId) {
      const member = await getMember(rt.clubId, ws.userId);
      if (!member || Number(member.chips) < amount) return ctx.reply({ ok: false, error: "Royalle Pay insuficiente." });
      await adjustMemberChips(rt.clubId, ws.userId, -amount);
    } else if (rt.isQuick) {
      const wallet = await getOrCreateQuickWallet(ws.userId);
      if (Number(wallet.chips) < amount) return ctx.reply({ ok: false, error: "Fichas insuficientes." });
      await adjustQuickWalletChips(ws.userId, -amount);
    } else {
      return ctx.reply({ ok: false, error: "Essa mesa não aceita recompra." });
    }
    player.chips += amount;
    recordSessionBuyIn(rt.table, ws.username, amount);
    ctx.reply({ ok: true });
    broadcastTable(code);
    return;
  }

  if (type === "start_hand") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: false });
    if (rt.table.stage !== "idle" && rt.table.stage !== "showdown") return ctx.reply({ ok: false, error: "Já tem uma mão em andamento." });
    if (rt.table.players.filter((p) => p.chips > 0).length < (rt.minStartPlayers || 2)) {
      return ctx.reply({ ok: false, error: "Faltam jogadores pra atingir o mínimo dessa mesa." });
    }
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

  // Apelido pessoal — separado do login/username, mostrado na mesa e no
  // lobby. Qualquer apelido serve, só não pode repetir um já em uso
  // (checagem sem diferenciar maiúscula/minúscula, feita no store).
  if (type === "set_nickname") {
    if (!requireAuth(ws, ctx)) return;
    const trimmed = (msg.nickname || "").trim();
    if (trimmed.length < 3 || trimmed.length > 20) return ctx.reply({ ok: false, error: "O apelido precisa ter entre 3 e 20 caracteres." });
    const res = await setNickname(ws.userId, trimmed);
    if (!res.ok) return ctx.reply({ ok: false, error: res.error });
    const user = await findUserById(ws.userId);
    ctx.reply({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar, avatarImage: user.avatar_image || null, nickname: user.nickname || null, platformRole: user.platform_role || null } });
    const myClubs = await listClubsForUser(ws.userId);
    for (const c of myClubs) await broadcastClub(c.code);
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

  // Diferente do find_table (que acha QUALQUER mesa aberta daquela
  // variante/nível), esse aqui senta especificamente NESSA mesa — é o
  // que o botão "+" de um assento vazio chama, depois que alguém
  // levanta (continua assistindo) e quer (ou outra pessoa quer) sentar
  // de volta ali mesmo, sem ser jogado pra outra mesa.
  if (type === "sit_quick_table") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.isQuick || !rt.table) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    if (rt.table.players.some((p) => p.id === ws.username)) return ctx.reply({ ok: false, error: "Você já está sentado nessa mesa." });
    const tier = STAKES_TIERS[rt.tierIndex];
    if (!tier) return ctx.reply({ ok: false, error: "Configuração de mesa inválida." });
    const seatCap = Math.min(MAX_SEATS, maxPlayersForVariant(rt.variant));
    if (rt.table.players.length >= seatCap) return ctx.reply({ ok: false, error: "Mesa cheia." });
    const wallet = await getOrCreateQuickWallet(ws.userId);
    const minBuyIn = tier.buyIn;
    const maxBuyIn = tier.buyIn * 4;
    if (wallet.chips < minBuyIn) return ctx.reply({ ok: false, error: "Royalle Coins insuficientes pra esse nível." });
    const buyIn = Math.min(maxBuyIn, Math.max(minBuyIn, Number(msg.buyIn) || minBuyIn), wallet.chips);
    await adjustQuickWalletChips(ws.userId, -buyIn);
    rt.table.addPlayer(ws.username, ws.username, buyIn, false, Number.isInteger(msg.seat) ? msg.seat : null);
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
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

  if (type === "submit_run_it_choice") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const username = rt.socketToPlayer.get(ws);
    if (!username) return ctx.reply({ ok: false, error: "Você não está sentado." });
    const count = Number(msg.count);
    const result = rt.table.submitRunItChoice(username, count);
    if (!result.ok) return ctx.reply(result);
    broadcastTable(code);
    ctx.reply(result);
    return;
  }

  if (type === "rebuy_tournament") {
    if (!requireAuth(ws, ctx)) return;
    // Acha o torneio pelo tournamentId (mandado pelo cliente) em vez de
    // depender só do código da mesa — assim consigo dar uma mensagem
    // certa ("torneio já terminou") mesmo quando a mesa dele já foi
    // limpa do runtime (o que acontece assim que o torneio acaba),em vez
    // do genérico "mesa não encontrada" que não explica o motivo real.
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    if (!t.rebuy_allowed) return ctx.reply({ ok: false, error: "Esse torneio não permite recompra." });
    if (t.status === "finished" || t.status === "cancelled") return ctx.reply({ ok: false, error: "Esse torneio já terminou." });
    if (t.status !== "running") return ctx.reply({ ok: false, error: "Esse torneio ainda não começou." });
    const username = ws.username;
    const entry = await getTournamentEntry(t.id, ws.userId);
    if (!entry) return ctx.reply({ ok: false, error: "Você não está inscrito nesse torneio." });
    if (entry.status !== "eliminated") return ctx.reply({ ok: false, error: "Só dá pra recomprar depois de ser eliminado." });
    if (Number(entry.rebuys || 0) >= Number(t.rebuy_max)) return ctx.reply({ ok: false, error: "Limite de recompras atingido." });
    // Multiplicador (1.0x-3.0x) vezes Duplo/Triplo, igual o texto oficial
    // do pppoker: "no rebuy duplo, os jogadores pagam duas vezes o preço
    // do rebuy e recebem as fichas iniciais multiplicadas" pelo mesmo
    // fator do multiplicador escolhido.
    const factor = Number(t.rebuy_multiplier || 1) * (t.rebuy_triple ? 3 : t.rebuy_double ? 2 : 1);
    const price = Math.round(Number(t.buy_in) * factor);
    const chipsGranted = Math.round(Number(t.starting_chips) * factor);
    const member = await getMember(t.club_id, ws.userId);
    if (!member || Number(member.chips) < price) return ctx.reply({ ok: false, error: "Saldo insuficiente pra recomprar." });
    // A mesa dele especificamente ainda deveria existir (o torneio como
    // um todo está "running") — se não existir por algum motivo
    // inesperado, avisa direito em vez de travar numa mensagem genérica.
    let code = null;
    for (const [c, rt] of runtime.entries()) {
      if (rt.tournamentId === t.id) { code = c; break; }
    }
    if (!code) return ctx.reply({ ok: false, error: "Não achei nenhuma mesa aberta desse torneio pra te sentar de volta." });
    const rt = runtime.get(code);
    await adjustMemberChips(t.club_id, ws.userId, -price);
    await adjustClubTreasury(t.club_id, price);
    await updateTournamentEntry(t.id, ws.userId, {
      status: "playing", chips: chipsGranted, rank: null,
      rebuys: Number(entry.rebuys || 0) + 1, buy_in_paid: Number(entry.buy_in_paid || t.buy_in) + price,
    });
    // K.O. Progressivo: o rebuy também alimenta o pote próprio (senão
    // quem recompra várias vezes ficaria eliminando de graça); K.O.
    // Misterioso: soma no pote acumulado do torneio.
    if (t.bounty_enabled && t.ko_mode === "progressive") {
      const seed = Math.round(Number(t.buy_in) * factor * Number(t.bounty_percent) / 100);
      if (seed > 0) await updateTournamentEntry(t.id, ws.userId, { bounty_pool: Number(entry.bounty_pool || 0) + seed });
    } else if (t.bounty_enabled && t.ko_mode === "mystery") {
      const seed = Math.round(Number(t.buy_in) * factor * Number(t.bounty_percent) / 100);
      if (seed > 0) await updateTournament(t.id, { mystery_pool: Number(t.mystery_pool || 0) + seed });
    }
    // Carreira: registra o custo da recompra como perda, em fichas REAIS
    // do clube (não a pilha de fichas do torneio).
    await recordHandLedger(t.club_id, null, ws.userId, -price);
    // pulseTournamentTable já tirou esse jogador de rt.table.players
    // quando ele zerou — precisa sentar ele de novo, com a pilha nova.
    if (!rt.table.players.some((p) => p.id === username)) {
      rt.table.addPlayer(username, username, chipsGranted, false);
    }
    recordSessionBuyIn(rt.table, username, price);
    ctx.reply({ ok: true, chips: chipsGranted, code });
    broadcastTable(code);
    return;
  }

  if (type === "addon_tournament") {
    if (!requireAuth(ws, ctx)) return;
    const t = await getTournamentById(Number(msg.tournamentId));
    if (!t) return ctx.reply({ ok: false, error: "Torneio não encontrado." });
    if (!t.addon_enabled) return ctx.reply({ ok: false, error: "Esse torneio não tem add-on." });
    if (t.status !== "running") return ctx.reply({ ok: false, error: "Esse torneio não está em andamento." });
    const entry = await getTournamentEntry(t.id, ws.userId);
    if (!entry) return ctx.reply({ ok: false, error: "Você não está inscrito nesse torneio." });
    if (entry.status !== "playing") return ctx.reply({ ok: false, error: "Só dá pra fazer add-on enquanto ainda estiver na disputa." });
    if (entry.addon_used) return ctx.reply({ ok: false, error: "Você já usou seu add-on nesse torneio." });
    // Janela do add-on: só depois que o registro tardio encerrar (por
    // nível ou por minutos, o que o torneio usar), até
    // addon_pause_minutes depois disso. Simplificação assumida: o
    // relógio de blind do torneio não pausa de verdade nessa janela
    // (igual o pppoker descreve) — só a AÇÃO de add-on fica liberada
    // nesse intervalo de tempo.
    const tournamentStartedAt = new Date(t.start_time).getTime();
    const lateRegEndsAt = t.late_reg_level != null
      ? (Number(t.current_level || 0) > Number(t.late_reg_level) ? Date.now() : null)
      : tournamentStartedAt + Number(t.late_reg_minutes) * 60000;
    const windowOpen = lateRegEndsAt != null && Date.now() >= lateRegEndsAt;
    const windowClose = lateRegEndsAt != null ? lateRegEndsAt + Number(t.addon_pause_minutes) * 60000 : null;
    if (!windowOpen || (windowClose != null && Date.now() > windowClose)) {
      return ctx.reply({ ok: false, error: "Add-on só pode ser feito na janela logo depois do fim do registro tardio." });
    }
    const factor = Number(t.addon_multiplier || 1) * (t.addon_triple ? 3 : t.addon_double ? 2 : 1);
    const price = Math.round(Number(t.buy_in) * factor);
    const chipsGranted = Math.round(Number(t.starting_chips) * factor);
    const member = await getMember(t.club_id, ws.userId);
    if (!member || Number(member.chips) < price) return ctx.reply({ ok: false, error: "Saldo insuficiente pro add-on." });
    let code = null;
    for (const [c, rt] of runtime.entries()) {
      if (rt.tournamentId === t.id) { code = c; break; }
    }
    if (!code) return ctx.reply({ ok: false, error: "Não achei nenhuma mesa aberta desse torneio." });
    const rt = runtime.get(code);
    await adjustMemberChips(t.club_id, ws.userId, -price);
    await adjustClubTreasury(t.club_id, price);
    await updateTournamentEntry(t.id, ws.userId, {
      addon_used: true, chips: Number(entry.chips || 0) + chipsGranted,
      buy_in_paid: Number(entry.buy_in_paid || t.buy_in) + price,
    });
    if (t.bounty_enabled && t.ko_mode === "progressive") {
      const seed = Math.round(price * Number(t.bounty_percent) / 100);
      if (seed > 0) await updateTournamentEntry(t.id, ws.userId, { bounty_pool: Number(entry.bounty_pool || 0) + seed });
    } else if (t.bounty_enabled && t.ko_mode === "mystery") {
      const seed = Math.round(price * Number(t.bounty_percent) / 100);
      if (seed > 0) await updateTournament(t.id, { mystery_pool: Number(t.mystery_pool || 0) + seed });
    }
    await recordHandLedger(t.club_id, null, ws.userId, -price);
    const p = rt.table.players.find((pl) => pl.id === ws.username);
    if (p) p.chips = Number(p.chips || 0) + chipsGranted;
    ctx.reply({ ok: true, chips: Number(entry.chips || 0) + chipsGranted, code });
    broadcastTable(code);
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
    recordSessionBuyIn(rt.table, username, amount);
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
    // "Levantar" (stayInRoom=true): sai de jogar e recebe as fichas de
    // volta, mas continua CONECTADO à mesa — fica vendo ao vivo quem
    // está jogando, pode sentar nela de novo. "Sair" de verdade
    // (stayInRoom=false/ausente) desconecta e volta pra lista de mesas.
    const stayInRoom = !!msg.stayInRoom;

    // Mesa de TORNEIO: nunca converte a pilha de fichas do torneio em
    // saldo real — essa conversão só acontece do jeito certo (por
    // colocação final, via finishTournament). Sem essa trava, um
    // jogador que ganhasse o heads-up e clicasse "Sair da mesa" rápido
    // demais recebia a pilha inteira (ex: 21k) como se fossem fichas de
    // verdade, além do prêmio certo que o torneio já paga sozinho — seria
    // dinheiro sendo criado do nada. Só desconecta o socket dessa mesa;
    // pra navegar sem perder a vaga, usa o botão "voltar à mesa" (fica
    // disponível o tempo todo enquanto o torneio estiver rolando).
    if (rt.isTournament) {
      rt.socketToPlayer.delete(ws);
      rt.sockets.delete(ws);
      ctx.reply({ ok: true, chips: null, isTournament: true });
      return;
    }

    const username = rt.socketToPlayer.get(ws);
    const player = rt.table.players.find((p) => p.id === username);

    // "Tempo decretado" (variante "Sobre o lucro"): enquanto o jogador
    // estiver no positivo nessa sessão dessa mesa, ele não consegue
    // sair — só quando o lucro cair pra 0 ou menos, ou as fichas
    // acabarem. Confere ANTES de mexer em qualquer coisa.
    if (player && rt.clubId && rt.tableId) {
      const tCfg = await getClubTableById(rt.clubId, rt.tableId);
      if (tCfg?.advanced_flags?.decreedTime) {
        const stats = await getTablePlayerStats(rt.tableId, ws.userId);
        if (Number(stats.session_profit_chips) > 0 && player.chips > 0) {
          return ctx.reply({ ok: false, error: "Tempo decretado: você está no lucro nessa mesa, não dá pra sair agora." });
        }
      }
    }

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
      if (!already) rt.pendingLeave.add({ username, userId: ws.userId, stayInRoom });
      ctx.reply({ ok: true, pending: true });
      return;
    }

    if (rt.isQuick) {
      let chips = 0;
      if (player) {
        chips = await adjustQuickWalletChips(ws.userId, player.chips);
        freezeSessionResult(rt.table, username, player.chips);
        rt.table.removePlayer(username);
      }
      if (!stayInRoom) {
        rt.socketToPlayer.delete(ws);
        rt.sockets.delete(ws);
      }
      const stillReal = rt.table.players.some((p) => !p.isBot);
      if (!stillReal && !stayInRoom) runtime.delete(code);
      ctx.reply({ ok: true, chips, stayInRoom });
      if (runtime.has(code)) broadcastTable(code);
      return;
    }

    const clubCode = code.includes("#") ? code.split("#")[0] : code;
    const club = await getClubByCode(clubCode);
    let chips = 0;
    if (player && club) {
      chips = await adjustMemberChips(club.id, ws.userId, player.chips);
      freezeSessionResult(rt.table, username, player.chips);
      rt.table.removePlayer(username);
    }
    if (!stayInRoom) {
      resetIfEmpty(rt);
      rt.socketToPlayer.delete(ws);
    }
    // Se ficou na sala, o socket continua em rt.socketToPlayer — assim
    // ele continua recebendo table_state ao vivo (vendo quem senta, quem
    // sai, as posições), mesmo sem estar jogando mais.
    ctx.reply({ ok: true, chips, stayInRoom });
    await broadcastClub(clubCode);
    if (runtime.has(code)) broadcastTable(code);
    return;
  }

  console.warn("Tipo de mensagem desconhecido:", type);
  ctx.reply({ ok: false, error: `Tipo de mensagem desconhecido: ${type}` });
}

wss.on("connection", (ws, req) => {
  console.log("Nova conexão WebSocket recebida.");
  // Pro "Restrição de IP" — se tiver um proxy na frente (Render usa),
  // o IP real vem no header, não no socket direto.
  ws.remoteIp = (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req?.socket?.remoteAddress || null;
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
    if (ws.username && onlineByUsername.get(ws.username) === ws) onlineByUsername.delete(ws.username);
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
  .then(() => reloadClubLevelTiers())
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Royalle Poker server rodando na porta ${PORT}`);
    });
    // Relógio dos torneios — confere a cada 15s se algum precisa começar
    // sozinho (chegou a hora) ou subir de nível de blind.
    setInterval(() => { tickTournaments(); }, 15000);
    setInterval(() => { tickActionTimeouts(); }, 1000);
    setInterval(() => { tickTableDurations().catch((err) => console.error("Erro no relógio de duração de mesa:", err.message)); }, 30000);
  })
  .catch((err) => {
    console.error("Falha ao migrar banco de dados:", err);
    process.exit(1);
  });
