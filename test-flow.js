import { WebSocket } from "ws";

const URL = "ws://localhost:3001";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on("open", () => { console.log(label, "connected"); resolve(ws); });
    ws.on("error", reject);
  });
}
let reqCounter = 0;
function call(ws, type, payload = {}) {
  return new Promise((resolve) => {
    const reqId = String(++reqCounter);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ack" && msg.reqId === reqId) {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type, reqId, ...payload }));
  });
}

async function main() {
  const a = await connect("alice"); // Alice - owner
  const b = await connect("bruno"); // Bruno - member

  const created = await call(a, "create_club", { clubName: "Clube Teste", ownerName: "Alice" });
  console.log("club created:", created);
  const code = created.code;

  const joined = await call(b, "join_club", { code, playerName: "Bruno" });
  console.log("bruno joined:", joined);

  let aState = null, bState = null;
  a.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "table_state") aState = msg.state;
  });
  b.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "table_state") bState = msg.state;
  });

  const sitA = await call(a, "sit_table", { code, playerName: "Alice", buyIn: 2000 });
  const sitB = await call(b, "sit_table", { code, playerName: "Bruno", buyIn: 2000 });
  console.log("sit results:", sitA, sitB);

  a.send(JSON.stringify({ type: "start_hand", code }));
  await wait(300);

  console.log("\n--- Após dealer distribuir ---");
  console.log("Alice vê sua própria mão:", aState.players.find(p => p.id === "Alice").cards);
  console.log("Alice vê a mão do Bruno (deve ser [null,null]):", aState.players.find(p => p.id === "Bruno").cards);
  console.log("Bruno vê sua própria mão:", bState.players.find(p => p.id === "Bruno").cards);
  console.log("Bruno vê a mão da Alice (deve ser [null,null]):", bState.players.find(p => p.id === "Alice").cards);

  for (let i = 0; i < 20; i++) {
    const state = aState.actingId ? aState : bState;
    if (!state.actingId) { await wait(300); continue; }
    if (state.stage === "showdown") break;
    const actor = state.actingId === "Alice" ? a : b;
    const me = state.players.find(p => p.id === state.actingId);
    const toCall = state.currentBet - me.roundBet;
    const action = toCall > 0 ? "call" : "check";
    await call(actor, "player_action", { code, action });
    await wait(200);
  }
  await wait(1200);

  console.log("\n--- Showdown ---");
  console.log("stage:", aState.stage);
  console.log("results:", aState.results);
  console.log("log:\n" + aState.log.join("\n"));
  console.log("\nAlice vê a mão do Bruno no showdown:", aState.players.find(p => p.id === "Bruno").cards);

  const finalChipsSum = aState.players.reduce((s, p) => s + p.chips, 0);
  console.log("\nSoma de fichas na mesa agora:", finalChipsSum, "(esperado: 4000, buy-ins somados)");

  const leaveA = await call(a, "leave_table", { code });
  console.log("\nAlice saiu da mesa, saldo do clube:", leaveA);

  a.close(); b.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
