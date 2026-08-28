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

  console.log("--- signup ---");
  const signupA = await call(a, "signup", { username: "alice_test", password: "senha123", avatar: "avatar_03" });
  console.log("Alice signup:", signupA);
  const signupB = await call(b, "signup", { username: "bruno_test", password: "senha123", avatar: "avatar_07" });
  console.log("Bruno signup:", signupB);

  console.log("\n--- duplicate signup should fail ---");
  const dup = await call(a, "signup", { username: "alice_test", password: "outra", avatar: "avatar_01" });
  console.log("Duplicate signup (should fail):", dup);

  console.log("\n--- reconnect via login ---");
  const login = await call(a, "login", { username: "alice_test", password: "senha123" });
  console.log("Alice login:", login.ok, "token present:", Boolean(login.token));

  console.log("\n--- wrong password should fail ---");
  const wrongPw = await call(a, "login", { username: "alice_test", password: "errada" });
  console.log("Wrong password (should fail):", wrongPw);

  console.log("\n--- create + join club (persisted) ---");
  const created = await call(a, "create_club", { clubName: "Clube Persistente", smallBlind: 25, bigBlind: 50, buyIn: 2000, rakePercent: 10 });
  console.log("club created:", created);
  const code = created.code;
  const joined = await call(b, "join_club", { code });
  console.log("bruno joined:", joined);

  let state = null;
  const track = (raw) => { const msg = JSON.parse(raw.toString()); if (msg.type === "table_state") state = msg.state; };
  a.on("message", track); b.on("message", track);

  await call(a, "sit_table", { code, buyIn: 2000 });
  await call(b, "sit_table", { code, buyIn: 2000 });
  a.send(JSON.stringify({ type: "start_hand", code }));
  await wait(300);

  for (let i = 0; i < 20; i++) {
    if (!state || !state.actingId) { await wait(300); continue; }
    if (state.stage === "showdown") break;
    const actor = state.actingId === "alice_test" ? a : b;
    const me = state.players.find((p) => p.id === state.actingId);
    const toCall = state.currentBet - me.roundBet;
    await call(actor, "player_action", { code, action: toCall > 0 ? "call" : "check" });
    await wait(200);
  }
  await wait(1200);

  console.log("\n--- hand result (com rake de 10%) ---");
  console.log(state.log.join("\n"));

  const leaveA = await call(a, "leave_table", { code });
  console.log("\nAlice saiu, saldo:", leaveA);

  console.log("\n--- disconnect and reconnect: club balance should have persisted ---");
  a.close(); b.close();
  await wait(300);
  const c = await connect();
  const login2 = await call(c, "login", { username: "alice_test", password: "senha123" });
  const stateCheck = await call(c, "get_club_state", { code });
  console.log("Saldo da Alice depois de reconectar:", stateCheck.members.find((m) => m.username === "alice_test"));
  console.log("Rake semanal do clube:", stateCheck.weeklyRake);

  c.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
