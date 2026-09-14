// Bots que jogam DENTRO do motor real (pokerEngine.js) — não é uma
// simulação separada. Um bot é só um jogador comum com isBot:true; ele
// decide sua ação e chama table.applyAction exatamente como um jogador
// de carne e osso faria pelo WebSocket.

export const MAX_SEATS = 9;

const BOT_NAMES = [
  "Bot Ana", "Bot Rui", "Bot Léo", "Bot Duda", "Bot Kaio",
  "Bot Mila", "Bot Théo", "Bot Sara", "Bot Igor", "Bot Bia",
];

let botSeq = 0;
export function makeBotId() {
  botSeq += 1;
  return `bot-${Date.now().toString(36)}-${botSeq}`;
}
export function pickBotName(existingNames) {
  const free = BOT_NAMES.filter((n) => !existingNames.includes(n));
  return free[0] || `Bot ${Math.floor(Math.random() * 1000)}`;
}

// Heurística simples e propositalmente "humana" — não é solver de poker,
// é só o suficiente pra preencher a mesa de forma plausível e variada.
function handStrengthGuess(table, p) {
  const cards = p.cards || [];
  if (cards.length < 2) return 0.3;
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suited = cards.every((c) => c.suit === cards[0].suit);
  const pair = ranks.length >= 2 && ranks[0] === ranks[1];
  let score = (ranks[0] || 7) / 14; // carta alta pesa a maior parte
  if (pair) score += 0.35;
  if (suited) score += 0.08;
  if (table.community.length >= 3) {
    // pós-flop: um empurrão extra aleatório pra variar o comportamento
    // sem tentar avaliar a força real da mão (fica pra uma iteração futura).
    score += (Math.random() - 0.5) * 0.25;
  }
  return Math.max(0, Math.min(1, score));
}

export function pickBotAction(table, botId) {
  const p = table.players.find((pl) => pl.id === botId);
  if (!p) return { action: "fold" };
  const toCall = table.currentBet - p.roundBet;
  const strength = handStrengthGuess(table, p);
  const noise = Math.random();

  if (toCall <= 0) {
    // Pode passar de graça. Às vezes aposta se a mão parece boa.
    if (strength > 0.72 && noise < 0.55 && p.chips > table.bigBlind) {
      const amount = Math.min(p.roundBet + Math.max(table.minRaise, table.bigBlind * 2), p.roundBet + p.chips);
      return { action: "raise", amount };
    }
    return { action: "check" };
  }

  // Tem que pagar algo pra continuar.
  const potOdds = toCall / Math.max(1, table.pot + toCall);
  if (strength < 0.28 && noise < 0.72) return { action: "fold" };
  if (strength > 0.8 && noise < 0.35 && p.chips > toCall) {
    const raiseTo = Math.min(p.roundBet + toCall + Math.max(table.minRaise, table.bigBlind * 2), p.roundBet + p.chips);
    return { action: "raise", amount: raiseTo };
  }
  if (toCall >= p.chips) {
    // All-in pra pagar: só topa se a mão não for muito ruim.
    return strength > 0.35 ? { action: "call" } : { action: "fold" };
  }
  if (strength + 0.15 < potOdds * 2.2) return { action: "fold" };
  return { action: "call" };
}
