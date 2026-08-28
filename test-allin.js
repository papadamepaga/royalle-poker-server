import { WebSocket } from "ws";
const URL = "ws://localhost:3001";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect() { return new Promise((resolve, reject) => { const ws = new WebSocket(URL); ws.on("open", () => resolve(ws)); ws.on("error", reject); }); }
let reqCounter = 0;
function call(ws, type, payload = {}) {
  return new Promise((resolve) => {
    const reqId = String(++reqCounter);
    const handler = (raw) => { const msg = JSON.parse(raw.toString()); if (msg.type === "ack" && msg.reqId === reqId) { ws.off("message", handler); resolve(msg); } };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type, reqId, ...payload }));
  });
}
async function main() {
  const a = await connect(), b = await connect();
  const created = await call(a, "create_club", { clubName: "Teste Allin", ownerName: "Alice" });
  const code = created.code;
  await call(b, "join_club", { code, playerName: "Bruno" });
  let state = null;
  const track = (raw) => { const msg = JSON.parse(raw.toString()); if (msg.type === "table_state") state = msg.state; };
  a.on("message", track); b.on("message", track);
  await call(a, "sit_table", { code, playerName: "Alice", buyIn: 2000 });
  await call(b, "sit_table", { code, playerName: "Bruno", buyIn: 2000 });
  a.send(JSON.stringify({ type: "start_hand", code }));
  await wait(300);
  // whoever acts first goes all-in immediately, the other calls all-in
  const actor1 = state.actingId === "Alice" ? a : b;
  await call(actor1, "player_action", { code, action: "allin" });
  await wait(300);
  const actor2 = state.actingId === "Alice" ? a : b;
  await call(actor2, "player_action", { code, action: "allin" });
  console.log("Aguardando o runout automático (flop, turn, rio, showdown)...");
  await wait(5000); // enough time for 3 auto-runout ticks at 900ms each
  console.log("stage final:", state.stage);
  console.log("community:", state.community.map(c => c.rank + c.suit).join(" "));
  console.log("results:", state.results);
  console.log("log:\n" + state.log.join("\n"));
  if (state.stage !== "showdown") { console.error("FALHOU: não chegou ao showdown, travou em", state.stage); process.exit(1); }
  console.log("\nOK: chegou ao showdown normalmente.");
  a.close(); b.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
