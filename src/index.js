import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { customAlphabet } from "nanoid";
import { PokerTable } from "./pokerEngine.js";
import { migrate } from "./db.js";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.js";
import {
  AVATAR_OPTIONS, createUser, findUserByUsername, findUserById,
  createClub, getClubByCode, addMember, getMember, listMembers, listClubsForUser,
  adjustMemberChips, recordRake, getWeeklyRake,
  getOrCreateQuickWallet, adjustQuickWalletChips,
  updateUserAvatar, getUserStats, recordHandStat,
} from "./store.js";
import { MAX_SEATS, makeBotId, pickBotName, pickBotAction } from "./bots.js";

const PORT = process.env.PORT || 3001;
const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const makeQuickCode = customAlphabet("0123456789", 8);

// Mesas públicas de "Jogar" (fora de clube) — matchmaking automático por
// tipo de jogo. Só Hold'em está habilitado por enquanto; PLO4/5/6 usam o
// mesmo motor mas com regras de mão/aposta que ainda não implementamos,
// então ficam de fora do matchmaking até essa etapa ser feita.
const QUICK_VARIANTS = {
  holdem: { label: "Texas Hold'em", smallBlind: 25, bigBlind: 50, buyIn: 5000, enabled: true },
  plo4: { label: "4-Card PLO", smallBlind: 25, bigBlind: 50, buyIn: 5000, enabled: false },
  plo5: { label: "5-Card PLO", smallBlind: 25, bigBlind: 50, buyIn: 5000, enabled: false },
  plo6: { label: "6-Card PLO", smallBlind: 25, bigBlind: 50, buyIn: 5000, enabled: false },
};

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---- Runtime (in-memory, per-club live state) -------------------------
// Persistent stuff (users, club metadata, chip balances) lives in
// Postgres via store.js. This map only holds what's inherently transient:
// the live PokerTable instance and which sockets are currently watching
// or seated at a given club.
const runtime = new Map(); // code -> { clubId, sockets: Set<ws>, socketToPlayer: Map<ws, username>, table: PokerTable|null }

function ensureRuntime(code, clubId) {
  if (!runtime.has(code)) runtime.set(code, { clubId, sockets: new Set(), socketToPlayer: new Map(), table: null });
  return runtime.get(code);
}

function ensureQuickRuntime(code, variant) {
  if (!runtime.has(code)) {
    runtime.set(code, { clubId: null, isQuick: true, variant, sockets: new Set(), socketToPlayer: new Map(), table: null });
  }
  return runtime.get(code);
}

// Acha uma mesa pública dessa variante com vaga (de verdade vazia, ou
// ocupada por um bot que pode ser trocado por um jogador real). Prioriza
// mesas que já estão rolando em vez de criar uma nova.
function findOpenQuickTable(variant) {
  let botFallback = null;
  for (const [code, rt] of runtime.entries()) {
    if (!rt.isQuick || rt.variant !== variant || !rt.table) continue;
    const seated = rt.table.players.length;
    if (seated < MAX_SEATS) return { code, rt, botIdToReplace: null };
    const bot = rt.table.players.find((p) => p.isBot);
    if (bot && !botFallback) botFallback = { code, rt, botIdToReplace: bot.id };
  }
  return botFallback;
}

function fillWithBots(table, upTo = MAX_SEATS) {
  const names = table.players.map((p) => p.name);
  while (table.players.length < upTo) {
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
      table.applyAction(actingBot.id, decision.action, decision.amount);
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
  const payload = { type: "club_state", club: publicClub(club), members };
  for (const ws of rt.sockets) send(ws, payload);
}

function broadcastTable(code) {
  const rt = runtime.get(code);
  const table = rt?.table;
  if (!table) return;
  for (const [ws, username] of rt.socketToPlayer.entries()) {
    send(ws, { type: "table_state", state: table.getPublicState(username) });
  }
  maybeRecordRake(rt);
  if (table.needsAutoRunout()) {
    setTimeout(() => {
      if (rt.table !== table) return;
      table.advanceStage();
      broadcastTable(code);
    }, 900);
  }
  if (rt.isQuick) pulseQuickTable(code);
}

async function maybeRecordRake(rt) {
  if (rt.table?.pendingRake > 0) {
    const amount = rt.table.pendingRake;
    rt.table.pendingRake = 0;
    await recordRake(rt.clubId, amount);
  }
}

function publicClub(club) {
  if (!club) return null;
  return {
    code: club.code,
    name: club.name,
    smallBlind: club.small_blind,
    bigBlind: club.big_blind,
    buyIn: club.buy_in,
    rakePercent: Number(club.rake_percent),
    ownerId: club.owner_id,
  };
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
    ctx.reply({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar } });
    return;
  }

  if (type === "create_club") {
    if (!requireAuth(ws, ctx)) return;
    const code = makeCode();
    const club = await createClub({
      code,
      name: msg.clubName,
      ownerId: ws.userId,
      smallBlind: msg.smallBlind || 25,
      bigBlind: msg.bigBlind || 50,
      buyIn: msg.buyIn || 5000,
      rakePercent: msg.rakePercent ?? 5,
    });
    await addMember(club.id, ws.userId, 20000, "owner");
    const rt = ensureRuntime(code, club.id);
    rt.sockets.add(ws);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code });
    return;
  }

  if (type === "join_club") {
    if (!requireAuth(ws, ctx)) return;
    const club = await getClubByCode((msg.code || "").toUpperCase());
    if (!club) return ctx.reply({ ok: false, error: "Código não encontrado." });
    const existing = await getMember(club.id, ws.userId);
    if (!existing) await addMember(club.id, ws.userId, 5000, "member");
    const rt = ensureRuntime(club.code, club.id);
    rt.sockets.add(ws);
    ctx.setJoinedCode(club.code);
    ctx.reply({ ok: true, code: club.code, clubName: club.name });
    await broadcastClub(club.code);
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
    const weeklyRake = await getWeeklyRake(club.id);
    ctx.reply({ ok: true, club: publicClub(club), members, weeklyRake });
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
    const chips = await adjustMemberChips(club.id, target.id, msg.delta);
    ctx.reply({ ok: true, chips });
    await broadcastClub(club.code);
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
    if (rt.table.stage !== "idle") return ctx.reply({ ok: false, error: "Já tem uma mão em andamento." });
    rt.table.startHand();
    ctx.reply({ ok: true });
    broadcastTable(code);
    return;
  }

  if (type === "get_profile") {
    if (!requireAuth(ws, ctx)) return;
    const chips = await getOrCreateQuickWallet(ws.userId);
    const stats = await getUserStats(ws.userId);
    ctx.reply({ ok: true, chips, stats: { handsPlayed: Number(stats.hands_played), handsWon: Number(stats.hands_won) } });
    return;
  }

  if (type === "get_my_clubs") {
    if (!requireAuth(ws, ctx)) return;
    const clubs = await listClubsForUser(ws.userId);
    // Conta quantos jogadores estão sentados AGORA em cada clube — não
    // temos "várias mesas por clube", então isso é a informação real
    // equivalente ao que a Suprema chama de "Mesas".
    const withCounts = clubs.map((c) => ({ ...c, playersNow: runtime.get(c.code)?.table?.players?.length || 0 }));
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

    const walletChips = await getOrCreateQuickWallet(ws.userId);
    if (walletChips < cfg.buyIn) return ctx.reply({ ok: false, error: "Fichas insuficientes na carteira de jogo rápido." });

    let found = findOpenQuickTable(variant);
    let code, rt;
    if (found) {
      ({ code, rt } = found);
      if (found.botIdToReplace) rt.table.removePlayer(found.botIdToReplace);
    } else {
      code = makeQuickCode();
      rt = ensureQuickRuntime(code, variant);
      rt.table = new PokerTable({ smallBlind: cfg.smallBlind, bigBlind: cfg.bigBlind, rakePercent: 0, variant });
    }

    await adjustQuickWalletChips(ws.userId, -cfg.buyIn);
    rt.table.addPlayer(ws.username, ws.username, cfg.buyIn, false);
    if (!found) fillWithBots(rt.table);
    rt.sockets.add(ws);
    rt.socketToPlayer.set(ws, ws.username);
    ctx.setJoinedCode(code);
    ctx.reply({ ok: true, code, variant });
    broadcastTable(code);
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

  if (type === "leave_table") {
    if (!requireAuth(ws, ctx)) return;
    const code = (msg.code || "").toUpperCase();
    const rt = runtime.get(code);
    if (!rt?.table) return ctx.reply({ ok: true });
    const username = rt.socketToPlayer.get(ws);
    const player = rt.table.players.find((p) => p.id === username);

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

    const club = await getClubByCode(code);
    let chips = 0;
    if (player && club) {
      chips = await adjustMemberChips(club.id, ws.userId, player.chips);
      rt.table.removePlayer(username);
    }
    rt.socketToPlayer.delete(ws);
    ctx.reply({ ok: true, chips });
    await broadcastClub(code);
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
