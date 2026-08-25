import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { customAlphabet } from "nanoid";
import { PokerTable } from "./pokerEngine.js";

const PORT = process.env.PORT || 3001;
const makeCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---- In-memory store -------------------------------------------------
// IMPORTANT: this resets whenever the server restarts. It's fine for
// testing with friends, but a real launch needs a real database
// (Postgres, etc.) so clubs and chip balances survive restarts/deploys.
const clubs = new Map(); // code -> { name, ownerName, members: Map(name -> {chips, role}), table, sockets: Set, socketToPlayer: Map }

function ensureTable(club) {
  if (!club.table) club.table = new PokerTable({ smallBlind: 25, bigBlind: 50 });
  return club.table;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function clubMembersPayload(club) {
  return [...club.members.entries()].map(([name, m]) => ({ name, ...m }));
}

function broadcastClub(club) {
  const payload = { type: "club_state", name: club.name, members: clubMembersPayload(club) };
  for (const ws of club.sockets) send(ws, payload);
}

function broadcastTable(club) {
  const table = club.table;
  if (!table) return;
  for (const [ws, playerId] of club.socketToPlayer.entries()) {
    send(ws, { type: "table_state", state: table.getPublicState(playerId) });
  }
  if (table.needsAutoRunout()) {
    setTimeout(() => {
      if (club.table !== table) return; // table was replaced/reset
      table.advanceStage();
      broadcastTable(club);
    }, 900);
  }
}

// Handles one parsed message. `ctx.setJoinedCode` lets us remember, on the
// connection closure, which club this socket belongs to (for cleanup).
function handleMessage(ws, msg, ctx) {
  const { type, reply, setJoinedCode } = { ...msg, reply: ctx.reply, setJoinedCode: ctx.setJoinedCode };

  if (type === "create_club") {
    const code = makeCode();
    const club = {
      name: msg.clubName,
      ownerName: msg.ownerName,
      members: new Map([[msg.ownerName, { chips: 20000, role: "owner" }]]),
      table: null,
      sockets: new Set(),
      socketToPlayer: new Map(),
    };
    clubs.set(code, club);
    club.sockets.add(ws);
    setJoinedCode(code);
    ctx.reply({ ok: true, code });
    return;
  }

  if (type === "join_club") {
    const club = clubs.get(msg.code);
    if (!club) return ctx.reply({ ok: false, error: "Código não encontrado." });
    if (!club.members.has(msg.playerName)) club.members.set(msg.playerName, { chips: 5000, role: "member" });
    club.sockets.add(ws);
    setJoinedCode(msg.code);
    ctx.reply({ ok: true, clubName: club.name });
    broadcastClub(club);
    return;
  }

  if (type === "get_club_state") {
    const club = clubs.get(msg.code);
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    club.sockets.add(ws);
    setJoinedCode(msg.code);
    ctx.reply({ ok: true, name: club.name, members: clubMembersPayload(club) });
    if (club.table) send(ws, { type: "table_state", state: club.table.getPublicState(null) });
    return;
  }

  if (type === "adjust_chips") {
    const club = clubs.get(msg.code);
    if (!club) return ctx.reply({ ok: false });
    const m = club.members.get(msg.targetName);
    if (!m) return ctx.reply({ ok: false });
    m.chips = Math.max(0, m.chips + msg.delta);
    ctx.reply({ ok: true, chips: m.chips });
    broadcastClub(club);
    return;
  }

  if (type === "sit_table") {
    const club = clubs.get(msg.code);
    if (!club) return ctx.reply({ ok: false, error: "Clube não encontrado." });
    const member = club.members.get(msg.playerName);
    if (!member || member.chips < msg.buyIn) return ctx.reply({ ok: false, error: "Fichas insuficientes." });
    member.chips -= msg.buyIn;
    const table = ensureTable(club);
    table.addPlayer(msg.playerName, msg.playerName, msg.buyIn);
    club.socketToPlayer.set(ws, msg.playerName);
    ctx.reply({ ok: true });
    broadcastClub(club);
    broadcastTable(club);
    return;
  }

  if (type === "start_hand") {
    const club = clubs.get(msg.code);
    if (!club?.table) return ctx.reply({ ok: false });
    club.table.startHand();
    ctx.reply({ ok: true });
    broadcastTable(club);
    return;
  }

  if (type === "player_action") {
    const club = clubs.get(msg.code);
    if (!club?.table) return ctx.reply({ ok: false, error: "Mesa não encontrada." });
    const playerId = club.socketToPlayer.get(ws);
    if (!playerId) return ctx.reply({ ok: false, error: "Você não está sentado." });
    const result = club.table.applyAction(playerId, msg.action, msg.amount);
    broadcastTable(club);
    ctx.reply(result?.error ? { ok: false, error: result.error } : { ok: true });
    return;
  }

  if (type === "leave_table") {
    const club = clubs.get(msg.code);
    if (!club?.table) return ctx.reply({ ok: true });
    const playerName = club.socketToPlayer.get(ws);
    const player = club.table.players.find((p) => p.id === playerName);
    if (player) {
      const member = club.members.get(playerName);
      if (member) member.chips += player.chips;
      club.table.removePlayer(playerName);
    }
    club.socketToPlayer.delete(ws);
    ctx.reply({ ok: true, chips: club.members.get(playerName)?.chips ?? 0 });
    broadcastClub(club);
    broadcastTable(club);
    return;
  }

  console.warn("Tipo de mensagem desconhecido:", type);
  ctx.reply({ ok: false, error: `Tipo de mensagem desconhecido: ${type}` });
}

wss.on("connection", (ws) => {
  console.log("Nova conexão WebSocket recebida.");
  let joinedCode = null;

  ws.on("message", (raw) => {
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
      handleMessage(ws, msg, { reply, setJoinedCode: (c) => { joinedCode = c; } });
    } catch (err) {
      console.error("Erro processando mensagem", msg.type, err);
      reply({ ok: false, error: "Erro interno no servidor." });
    }
  });

  ws.on("close", () => {
    console.log("Conexão WebSocket fechada.");
    if (!joinedCode) return;
    const club = clubs.get(joinedCode);
    if (!club) return;
    const playerId = club.socketToPlayer.get(ws);
    if (playerId && club.table) {
      const p = club.table.players.find((pl) => pl.id === playerId);
      if (p) p.connected = false;
      broadcastTable(club);
    }
    club.sockets.delete(ws);
    club.socketToPlayer.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("Erro no WebSocket:", err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Royalle Poker server rodando na porta ${PORT}`);
});
