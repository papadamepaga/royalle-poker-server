// Motor de poker autoritativo. Roda inteiramente no servidor — é o único
// lugar que enxerga as cartas de todo mundo. Os clientes só recebem a
// visão "pública" da mesa (getPublicState), que esconde as cartas dos
// outros jogadores até o showdown.

const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const SUITS = ["s", "h", "d", "c"];
export const CATEGORY_NAMES = [
  "Carta alta", "Par", "Dois pares", "Trinca", "Sequência",
  "Flush", "Full house", "Quadra", "Straight flush",
];

// Config central de cada variante — é daqui que TUDO parte (quantas cartas
// privadas, estrutura de aposta, avaliador). Nenhum outro lugar do motor
// deve ter "4"/"5"/"6"/"PLO" hardcoded fora daqui.
export const GAME_VARIANTS = {
  holdem: { name: "Texas Hold'em", holeCards: 2, bettingStructure: "NO_LIMIT", evaluator: "HOLDEM" },
  plo4: { name: "PLO 4 Cards", holeCards: 4, bettingStructure: "POT_LIMIT", evaluator: "OMAHA" },
  plo5: { name: "PLO 5 Cards", holeCards: 5, bettingStructure: "POT_LIMIT", evaluator: "OMAHA" },
  plo6: { name: "PLO 6 Cards", holeCards: 6, bettingStructure: "POT_LIMIT", evaluator: "OMAHA" },
};
function variantConfig(variant) { return GAME_VARIANTS[variant] || GAME_VARIANTS.holdem; }
// Quantos jogadores CABEM nessa variante sem estourar o baralho de 52
// cartas (N jogadores × cartas por jogador + 5 comunitárias ≤ 52).
// Usado na criação/edição de mesa pra nunca deixar configurar um
// maxPlayers impossível pra variante escolhida.
export function maxPlayersForVariant(variant) {
  const holeCount = variantConfig(variant).holeCards;
  return Math.max(2, Math.floor((52 - 5) / holeCount));
}

function freshDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push({ rank: r, suit: s });
  return d;
}
function shuffle(deck) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function combinations(arr, k) {
  const res = [], combo = [];
  (function go(start) {
    if (combo.length === k) { res.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); go(i + 1); combo.pop(); }
  })(0);
  return res;
}
export function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const flush = suits.every((s) => s === suits[0]);
  const counts = {};
  ranks.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const rankSet = new Set(ranks);
  let straightHigh = null;
  for (let high = 14; high >= 5; high--) {
    const need = high === 5 ? [5, 4, 3, 2, 14] : [high, high - 1, high - 2, high - 3, high - 4];
    if (high === 5 && !rankSet.has(14)) continue;
    if (need.every((r) => rankSet.has(r))) { straightHigh = high; break; }
  }
  let category, kickers;
  if (flush && straightHigh) { category = 8; kickers = [straightHigh]; }
  else if (groups[0].count === 4) { category = 7; kickers = [groups[0].rank, groups[1].rank]; }
  else if (groups[0].count === 3 && groups[1] && groups[1].count >= 2) { category = 6; kickers = [groups[0].rank, groups[1].rank]; }
  else if (flush) { category = 5; kickers = ranks.slice(0, 5); }
  else if (straightHigh) { category = 4; kickers = [straightHigh]; }
  else if (groups[0].count === 3) { const rest = ranks.filter((r) => r !== groups[0].rank).slice(0, 2); category = 3; kickers = [groups[0].rank, ...rest]; }
  else if (groups[0].count === 2 && groups[1] && groups[1].count === 2) {
    const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    const kicker = ranks.find((r) => r !== pairRanks[0] && r !== pairRanks[1]);
    category = 2; kickers = [...pairRanks, kicker];
  } else if (groups[0].count === 2) { const rest = ranks.filter((r) => r !== groups[0].rank).slice(0, 3); category = 1; kickers = [groups[0].rank, ...rest]; }
  else { category = 0; kickers = ranks.slice(0, 5); }
  // Guarda as 5 cartas exatas que formaram essa mão — usado depois pra
  // destacar/brilhar só essas cartas na tela (não precisa recalcular).
  return { category, kickers, cards };
}
export function compareScores(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < a.kickers.length; i++) {
    const diff = (a.kickers[i] || 0) - (b.kickers[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// A regra "as duas cartas da mão devem ser usadas" É ESPECÍFICA de cada
// tipo de mão — não basta 2 das 5 cartas finais baterem com a mão do
// jogador, porque numa quadra a 5ª carta é só kicker (poderia vir do
// board sem problema e não conta pra qualificar). O que precisa mesmo:
// - Quadra: as DUAS cartas da mão formam o par que virou quadra (mesmo
//   rank da quadra nas duas).
// - Full House (só Hold'em, quadra perdendo): mesma ideia, só que o par
//   da mão virou a TRINCA (rank >= valete).
// - Straight/Royal Flush: as duas cartas da mão estão entre as 5 que
//   formam a sequência (não interessa qual posição).
// Quais das 5 cartas finais vieram da mão do jogador — funciona tanto
// pro Hold'em (2 cartas na mão) quanto pro Omaha (4/5/6 cartas na mão,
// mas só 2 delas entram na mão final de qualquer jeito, pela regra da
// própria variante). Casa por rank+naipe.
function usedHoleCards(score, holeCards) {
  if (!score?.cards || !holeCards) return [];
  const pool = [...holeCards];
  const used = [];
  for (const c of score.cards) {
    const idx = pool.findIndex((h) => h.rank === c.rank && h.suit === c.suit);
    if (idx !== -1) { used.push(pool[idx]); pool.splice(idx, 1); }
  }
  return used;
}
function jackpotQualifies(score, holeCards) {
  if (!score) return false;
  const used = usedHoleCards(score, holeCards);
  if (score.category === 8) return used.length === 2; // straight/royal flush: as 5 cartas finais SÃO a sequência, então "2 usadas" já garante que formaram a sequência
  if (score.category === 7) return used.filter((c) => c.rank === score.kickers[0]).length === 2; // quadra: as duas cartas da mão têm que SER o par que virou quadra (não um kicker qualquer)
  if (score.category === 6 && score.kickers[0] >= 11) return used.filter((c) => c.rank === score.kickers[0]).length === 2; // full house de valetes+: par da mão virou a trinca
  return false;
}

// Detecta se essa mão (já resolvida, showdown de verdade com 2+
// contendores) rendeu um evento de Jackpot — Cooler (quadra perde pra
// quadra ou melhor) ou Mão Forte (quadra/straight flush/royal flush
// vence sem cooler). Função pura: só olha as mãos já calculadas, não
// mexe em fichas nem em pote — quem paga o prêmio de verdade é o
// index.js (ele já sabe se o clube tem jackpot ligado e de que tipo).
// holeCardsById: { [playerId]: cartas da mão desse jogador }.
export function detectJackpotEvent(scored, contenderIds, holeCardsById, variant) {
  const ranked = contenderIds
    .map((id) => ({ id, score: scored[id] }))
    .filter((r) => r.score)
    .sort((a, b) => compareScores(b.score, a.score));
  if (ranked.length < 1) return null;
  const top = ranked[0];
  const second = ranked[1];
  const isQuadPlus = (s) => s.category >= 7;
  const qualifies = (r) => jackpotQualifies(r.score, holeCardsById[r.id]);

  // COOLER — quadra (ou melhor) perde pra quadra (ou melhor). No
  // Hold'em, Full House de valetes+ perdendo pra quadra também conta.
  if (second && isQuadPlus(top.score) && qualifies(top)) {
    if (isQuadPlus(second.score) && qualifies(second)) {
      return { kind: "cooler", winnerId: top.id, loserId: second.id, loserCategory: second.score.category };
    }
    if (variant === "holdem" && second.score.category === 6 && qualifies(second)) {
      return { kind: "cooler", winnerId: top.id, loserId: second.id, loserCategory: 6 };
    }
  }

  // MÃO FORTE — sem cooler, o vencedor sozinho bate quadra (só Hold'em),
  // straight flush ou royal flush.
  if (qualifies(top)) {
    if (top.score.category === 8) {
      const isRoyal = top.score.kickers[0] === 14;
      return { kind: "strong", winnerId: top.id, trigger: isRoyal ? "royal" : "straightflush" };
    }
    if (top.score.category === 7 && variant === "holdem") {
      return { kind: "strong", winnerId: top.id, trigger: "quads" };
    }
  }
  return null;
}
function bestOf7(cards7) {
  let best = null;
  for (const c of combinations(cards7, 5)) {
    const s = evaluate5(c);
    if (!best || compareScores(s, best) > 0) best = s;
  }
  return best;
}
// Omaha: a mão vencedora TEM que usar exatamente 2 cartas da mão do
// jogador + exatamente 3 do board — nunca 1+4, 3+2, nem as 5 do board
// sozinhas. Testa todas as combinações válidas (C(hole,2) × C(board,3)) e
// pega a melhor — nunca deixa passar uma combinação com contagem errada.
export function bestOfOmaha(holeCards, board) {
  let best = null;
  const holeCombos = combinations(holeCards, 2);
  const boardCombos = combinations(board, 3);
  for (const h of holeCombos) {
    for (const b of boardCombos) {
      const s = evaluate5([...h, ...b]);
      if (!best || compareScores(s, best) > 0) best = s;
    }
  }
  return best;
}
// Ponto único de entrada pra "qual é a melhor mão desse jogador agora" —
// escolhe Hold'em (7 cartas livres) ou Omaha (2+3 forçado) conforme a
// variante da mesa. Retorna null se ainda não dá pra avaliar (ex: antes
// do flop, ou hole cards insuficientes).
export function bestHandFor(holeCards, community, variant) {
  const cfg = variantConfig(variant);
  if (cfg.evaluator === "OMAHA") {
    if (!holeCards || holeCards.length < 2 || !community || community.length < 3) return null;
    return bestOfOmaha(holeCards, community);
  }
  const merged = [...(holeCards || []), ...(community || [])];
  if (merged.length < 5) return null;
  return bestOf7(merged);
}
// Teto de Pot-Limit: quanto o jogador pode colocar no MÁXIMO nesta ação.
// Fórmula (ver seção 9 da especificação):
//   toCall = quanto falta pra pagar
//   pote depois do call = this.pot (já inclui tudo até agora) + toCall
//   raise máximo adicional = pote depois do call
//   total máximo = roundBet + toCall + (pote depois do call)
//                = roundBet + 2*toCall + this.pot
// Sempre também limitado ao stack do jogador (nunca pode apostar o que
// não tem). Pra No-Limit, o teto é só o stack — sem limite de pote.
export function potLimitMaxRaiseTotal(pot, currentBet, roundBet, chips) {
  const toCall = Math.max(0, currentBet - roundBet);
  const stackCap = roundBet + chips;
  const potLimitCap = roundBet + 2 * toCall + pot;
  return Math.min(potLimitCap, stackCap);
}
function computePots(players) {
  let contribs = players.map((p) => ({ id: p.id, amt: p.totalBet, folded: p.folded })).filter((c) => c.amt > 0);
  const pots = [];
  while (contribs.some((c) => c.amt > 0)) {
    const involved = contribs.filter((c) => c.amt > 0);
    const min = Math.min(...involved.map((c) => c.amt));
    const amount = min * involved.length;
    const eligible = involved.filter((c) => !c.folded).map((c) => c.id);
    // Quanto cada jogador (mesmo quem desistiu) colocou NESSA camada do
    // pote — precisa disso pra atribuir o rake proporcionalmente a quem
    // realmente colocou o dinheiro, não só a quem ganhou (sistema de
    // rakeback/comissão de agente precisa saber quem "gerou" o rake).
    const contributions = {};
    involved.forEach((c) => { contributions[c.id] = min; });
    pots.push({ amount, eligible, contributions });
    involved.forEach((c) => { c.amt -= min; });
  }
  return pots;
}
function nextRotationSeat(players, from) {
  const n = players.length;
  for (let step = 1; step <= n; step++) { const i = (from + step) % n; if (players[i].chips > 0) return i; }
  return from;
}
function nextToActSeat(players, from) {
  const n = players.length;
  for (let step = 1; step <= n; step++) { const i = (from + step) % n; const p = players[i]; if (p.inHand && !p.folded && !p.allIn) return i; }
  return -1;
}
function activeInHand(players) { return players.filter((p) => p.inHand && !p.folded); }
function needMoreAction(players) { return players.filter((p) => p.inHand && !p.folded && !p.allIn).length > 1; }

// Quantos pontos percentuais do pote (não do rake configurado) sempre vão
// pro app, independente do rake total que o dono da mesa configurou. Ex:
// mesa com rake 5% -> 4% pro clube, 1% pro app. Mesa com rake 2% -> 1% pro
// clube, 1% pro app (o app nunca fica sem seu ponto, mas também nunca tira
// mais do que o rake total configurado).
const PLATFORM_RAKE_POINTS = 1;

// Simulação Monte Carlo simples pra estimar a % de vitória de cada jogador
// ainda na mão, a partir das cartas já conhecidas (mãos + mesa). Só faz
// sentido chamar quando as cartas de todo mundo já estão reveladas (all-in
// ou showdown) — por isso sempre recebe as cartas reais dos contendores.
function computeWinProbs(contenders, community, variant) {
  const probs = {};
  if (contenders.length < 2) return probs;
  const known = new Set();
  contenders.forEach((p) => p.cards.forEach((c) => known.add(c.rank + c.suit)));
  community.forEach((c) => known.add(c.rank + c.suit));
  const remaining = freshDeck().filter((c) => !known.has(c.rank + c.suit));
  const needed = 5 - community.length;
  const trials = 300;
  const wins = {};
  contenders.forEach((p) => (wins[p.id] = 0));
  for (let t = 0; t < trials; t++) {
    const pool = shuffle(remaining);
    const runout = [...community, ...pool.slice(0, needed)];
    let best = null, winners = [];
    contenders.forEach((p) => {
      const s = bestHandFor(p.cards, runout, variant);
      if (!best || compareScores(s, best) > 0) { best = s; winners = [p.id]; }
      else if (compareScores(s, best) === 0) winners.push(p.id);
    });
    winners.forEach((id) => (wins[id] += 1 / winners.length));
  }
  contenders.forEach((p) => { probs[p.id] = Math.round((wins[p.id] / trials) * 100); });
  return probs;
}

// Igual computeWinProbs, mas devolve a fração exata (não arredondada em
// %) de cada contendor — usado só pelo "Dividir EV", onde arredondar
// pra porcentagem inteira faria a soma dos pagamentos não bater com o
// pote exato.
function computeEquityFractions(contenders, community, variant, trials = 500) {
  const eq = {};
  if (contenders.length < 1) return eq;
  if (contenders.length === 1) { eq[contenders[0].id] = 1; return eq; }
  const known = new Set();
  contenders.forEach((p) => p.cards.forEach((c) => known.add(c.rank + c.suit)));
  community.forEach((c) => known.add(c.rank + c.suit));
  const remaining = freshDeck().filter((c) => !known.has(c.rank + c.suit));
  const needed = Math.max(0, 5 - community.length);
  const wins = {};
  contenders.forEach((p) => (wins[p.id] = 0));
  for (let t = 0; t < trials; t++) {
    const pool = shuffle(remaining);
    const runout = [...community, ...pool.slice(0, needed)];
    let best = null, winners = [];
    contenders.forEach((p) => {
      const s = bestHandFor(p.cards, runout, variant);
      if (!best || compareScores(s, best) > 0) { best = s; winners = [p.id]; }
      else if (compareScores(s, best) === 0) winners.push(p.id);
    });
    winners.forEach((id) => (wins[id] += 1 / winners.length));
  }
  contenders.forEach((p) => { eq[p.id] = wins[p.id] / trials; });
  return eq;
}

export class PokerTable {
  constructor({ smallBlind = 25, bigBlind = 50, rakePercent = 0, variant = "holdem", maxSeats = 9, rakeCapBb = 3, actionSeconds = 30, revealFoldedCards = true, seeInAction = false, straddleEnabled = false, runItMultiple = false, splitEv = false } = {}) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.rakePercent = rakePercent; // e.g. 5 means 5% of each pot
    this.rakeCapBb = rakeCapBb; // "Teto" da tela de criar mesa — nunca tira mais que isso (em BB) de um pote só
    this.actionSeconds = actionSeconds; // "Tempo de ação" configurável por mesa
    this.revealFoldedCards = revealFoldedCards; // "Ver Cartas Descartadas" da tela de criar mesa
    this.seeInAction = seeInAction; // "Ver em ação"
    this.straddleEnabled = straddleEnabled; // "Straddle UTG automático"
    this.runItMultiple = runItMultiple; // "Bater duas vezes"
    this.splitEv = splitEv; // "Dividir EV"
    this.variant = variant; // "holdem" | "plo4" | "plo5" | "plo6" (só holdem implementado por enquanto)
    // Quantidade de assentos físicos ao redor da mesa — fixo desde a
    // criação, independe de quantos estão sentados agora. É o que deixa
    // a UI desenhar um "+" nos vazios em vez de só reorganizar todo
    // mundo mais apertado a cada entrada/saída.
    this.maxSeats = Math.max(2, Number(maxSeats) || 9);
    this.players = []; // { id, name, chips, cards, folded, allIn, inHand, roundBet, totalBet, connected, isBot, seat }
    this.deck = [];
    this.community = [];
    this.stage = "idle"; // idle | preflop | flop | turn | river | showdown
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.actingId = null;
    this.dealerId = null;
    this.pot = 0;
    this.log = [];
    this.results = {};
    this.toActQueue = [];
    this.pendingRake = 0; // chips raked (parte do CLUBE) na mão mais recente, ainda não gravados pelo caller
    this.pendingRakeByPlayer = {}; // { playerId: quanto desse rake veio dele } — base do sistema de rakeback/comissão
    this.pendingPlatformRake = 0; // chips raked (parte do APP) na mão mais recente, ainda não gravados pelo caller
    this.allInRunout = false;
    this.winProbs = {}; // { playerId: percentInteiro } — só preenchido durante all-in runout / showdown
    this.winningHandCards = {}; // { playerId: [5 cartas] } — só preenchido em showdown de verdade (não quando todo mundo desiste)
    // Resultado em tempo real por jogador nessa mesa (buy-in total vs
    // saldo atual) — mantido pelo index.js (sit/rebuy/leave), a engine só
    // guarda e expõe. Sobrevive à mesa inteira (não reseta a cada mão),
    // só quando a mesa esvazia de verdade (index.js cria um PokerTable novo).
    this.sessionStats = {};
    this.handHistory = []; // últimas mãos completas, ver recordHandHistorySnapshot
  }
  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 30) this.log.shift();
  }

  addPlayer(id, name, chips, isBot = false, seat = null) {
    if (this.players.find((p) => p.id === id)) return;
    const taken = new Set(this.players.map((p) => p.seat));
    let seatIndex = Number.isInteger(seat) && seat >= 0 && seat < this.maxSeats && !taken.has(seat) ? seat : null;
    if (seatIndex === null) {
      // Sem assento pedido (bots, mesa rápida, torneio) ou o pedido já
      // tava ocupado — pega o primeiro vazio disponível.
      for (let i = 0; i < this.maxSeats; i++) { if (!taken.has(i)) { seatIndex = i; break; } }
      if (seatIndex === null) return; // mesa cheia
    }
    const player = { id, name, chips, cards: [], folded: false, allIn: false, inHand: false, roundBet: 0, totalBet: 0, connected: true, isBot, away: false, seat: seatIndex };
    // Mantém this.players sempre ordenado por assento físico — o resto
    // da engine (ordem de ação, rotação do dealer) caminha por esse
    // array em sequência assumindo que ele já representa a ordem física
    // ao redor da mesa, então quem entra precisa ser inserido no lugar
    // certo, não só empilhado no fim.
    const idx = this.players.findIndex((p) => p.seat > seatIndex);
    if (idx === -1) this.players.push(player); else this.players.splice(idx, 0, player);
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
  }

  buildActOrder(firstSeatIndex) {
    const order = [];
    let i = firstSeatIndex;
    for (let step = 0; step < this.players.length; step++) {
      const p = this.players[i];
      if (p.inHand && !p.folded && !p.allIn) order.push(p.id);
      i = (i + 1) % this.players.length;
    }
    return order;
  }

  seatIndexOf(id) { return this.players.findIndex((p) => p.id === id); }

  // Fonte única de verdade pra "quanto esse jogador pode colocar no
  // máximo agora" — usada tanto pra validar applyAction quanto pra
  // informar o cliente (getPublicState). A UI nunca decide isso sozinha.
  getMaxRaiseTotal(playerId) {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return 0;
    const stackCap = p.roundBet + p.chips;
    const cfg = variantConfig(this.variant);
    if (cfg.bettingStructure !== "POT_LIMIT") return stackCap;
    return potLimitMaxRaiseTotal(this.pot, this.currentBet, p.roundBet, p.chips);
  }

  startHand() {
    if (this.players.filter((p) => p.chips > 0).length < 2) {
      this.addLog("Fichas insuficientes na mesa pra continuar.");
      return;
    }
    // Blindagem: nunca começar uma mão se o baralho de 52 cartas não for
    // suficiente pra distribuir todo mundo + as 5 comunitárias. Isso não
    // deveria acontecer (a criação/edição de mesa já limita o máximo de
    // jogadores por variante), mas é barato conferir de novo aqui — melhor
    // recusar a mão do que distribuir carta undefined pra alguém.
    const playing = this.players.filter((p) => p.chips > 0).length;
    const holeCount = variantConfig(this.variant).holeCards;
    if (playing * holeCount + 5 > 52) {
      this.addLog("Jogadores demais pra essa variante — o baralho não alcança.");
      return;
    }
    this.deck = shuffle(freshDeck());
    // Fotografia das fichas de cada jogador ANTES da mão começar — é a
    // referência pra calcular ganho/perda líquido dessa mão (usado na
    // Carreira). Guardamos só de quem realmente vai jogar.
    this.handStartChips = {};
    this.players.forEach((p) => { if (p.chips > 0) { this.handStartChips[p.id] = p.chips; p.vpipThisHand = false; p.sawOwnTurnThisHand = false; } });
    this.lastHandDeltas = null;
    this.players.forEach((p) => {
      p.cards = []; p.folded = false; p.allIn = false; p.inHand = p.chips > 0; p.roundBet = 0; p.totalBet = 0;
    });
    const dealerIdx = this.dealerId === null ? 0 : nextRotationSeat(this.players, this.seatIndexOf(this.dealerId));
    this.dealerId = this.players[dealerIdx].id;
    this.players.forEach((p) => {
      if (!p.inHand) return;
      p.cards = [];
      for (let i = 0; i < holeCount; i++) p.cards.push(this.deck.pop());
    });

    const sbIdx = nextRotationSeat(this.players, dealerIdx);
    const bbIdx = nextRotationSeat(this.players, sbIdx);
    const sb = this.players[sbIdx], bb = this.players[bbIdx];
    const sbAmt = Math.min(this.smallBlind, sb.chips);
    sb.chips -= sbAmt; sb.roundBet = sbAmt; sb.totalBet = sbAmt; if (sb.chips === 0) sb.allIn = true;
    const bbAmt = Math.min(this.bigBlind, bb.chips);
    bb.chips -= bbAmt; bb.roundBet = bbAmt; bb.totalBet = bbAmt; if (bb.chips === 0) bb.allIn = true;

    this.community = [];
    this.stage = "preflop";
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.results = {};
    this.pot = sbAmt + bbAmt;
    this.allInRunout = false;
    this.winProbs = {};
    this.winningHandCards = {};

    let firstActorSeatForQueue = bbIdx;
    // Straddle UTG automático: com 4+ jogadores na mão, o UTG (primeiro
    // a agir depois do BB) entra automaticamente com uma aposta forçada
    // de 2x o big blind, ANTES de qualquer carta ser olhada — igual uma
    // raise "as cegas". currentBet e minRaise sobem juntos, e a ação
    // começa depois dele (ele mantém a opção de re-agir quando a rodada
    // voltar pra ele, mesma lógica que o BB já tem hoje sem straddle).
    if (this.straddleEnabled && playing >= 4) {
      const utgIdx = nextToActSeat(this.players, bbIdx);
      if (utgIdx !== -1) {
        const utg = this.players[utgIdx];
        const straddleAmt = Math.min(this.bigBlind * 2, utg.chips);
        utg.chips -= straddleAmt; utg.roundBet = straddleAmt; utg.totalBet += straddleAmt;
        if (utg.chips === 0) utg.allIn = true;
        this.pot += straddleAmt;
        this.currentBet = straddleAmt;
        this.minRaise = Math.max(this.bigBlind, straddleAmt - this.bigBlind);
        this.addLog(`${utg.name} paga o straddle automático (${straddleAmt}).`);
        firstActorSeatForQueue = utgIdx;
      }
    }

    const firstActor = nextToActSeat(this.players, firstActorSeatForQueue);
    this.toActQueue = firstActor === -1 ? [] : this.buildActOrder(firstActor);
    this.actingId = this.toActQueue[0] ?? null;
    this.addLog(`Nova mão. ${sb.name} paga small blind (${sbAmt}), ${bb.name} paga big blind (${bbAmt}).`);
  }

  applyAction(playerId, action, amount) {
    if (this.actingId !== playerId) return { error: "Não é sua vez." };
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return { error: "Jogador não encontrado." };
    // Qualquer ação de verdade (manual ou automática) tira o jogador do
    // estado "ausente" — só quem realmente não age é que fica marcado.
    p.away = false;

    let raiseHappened = false;
    // VPIP ("Voluntarily Put money In Pot") — só conta call/raise/all-in
    // no PRÉ-flop que não seja só completar o que o blind forçado já
    // cobria (checar não conta, e pagar 0 de verdade — currentBet igual
    // ao que já tinha — também não). Usado pela regra "Nv. de VPIP".
    if (this.stage === "preflop" && (action === "call" || action === "raise" || action === "allin") && this.currentBet > p.roundBet) {
      p.vpipThisHand = true;
    }
    if (action === "fold") { p.folded = true; this.addLog(`${p.name} desiste.`); }
    else if (action === "check") {
      if (this.currentBet - p.roundBet > 0) return { error: "Não dá pra passar, tem aposta na mesa." };
      this.addLog(`${p.name} passa.`);
    } else if (action === "call") {
      const need = Math.min(this.currentBet - p.roundBet, p.chips);
      p.chips -= need; p.roundBet += need; p.totalBet += need;
      if (p.chips === 0) p.allIn = true;
      this.addLog(need > 0 ? `${p.name} paga ${need}.` : `${p.name} passa.`);
    } else if (action === "raise" || action === "allin") {
      // Teto: nunca deixa passar de getMaxRaiseTotal — é o mesmo cálculo
      // pra Pot-Limit (PLO) e sem teto extra pra No-Limit (Hold'em), então
      // o "all-in" também respeita o limite do pote quando a variante é
      // PLO (num stack fundo, o all-in de verdade em PLO pode ser MENOR
      // que o stack inteiro — não dá pra apostar mais do que o pote deixa,
      // mesmo estando all-in).
      const cap = this.getMaxRaiseTotal(playerId);
      const requestedTotal = action === "allin" ? (p.roundBet + p.chips) : Number(amount);
      const targetTotal = Math.min(requestedTotal, cap);
      const delta = targetTotal - p.roundBet;
      if (delta <= 0) return { error: "Valor de aumento inválido." };
      // Raise mínimo: se o jogador tem fichas suficientes pra completar o
      // raise mínimo legal, não deixa ele aumentar por menos que isso.
      // Quem não tem fichas suficientes ainda pode ir all-in por menos
      // (targetTotal bate exatamente no stackCap nesse caso).
      const stackCap = p.roundBet + p.chips;
      const legalMinTotal = Math.min(this.currentBet + this.minRaise, stackCap, cap);
      if (action === "raise" && targetTotal < legalMinTotal && targetTotal < stackCap) {
        return { error: "Valor abaixo do raise mínimo." };
      }
      p.chips -= delta; p.roundBet += delta; p.totalBet += delta;
      if (p.chips === 0) p.allIn = true;
      if (p.roundBet > this.currentBet) {
        raiseHappened = true;
        this.minRaise = p.roundBet - this.currentBet;
        this.currentBet = p.roundBet;
      }
      this.addLog(`${p.name} ${action === "allin" ? "vai all-in com" : "aumenta para"} ${p.roundBet}.`);
    } else {
      return { error: "Ação inválida." };
    }

    this.pot = this.players.reduce((s, pl) => s + pl.totalBet, 0);

    const contenders = activeInHand(this.players);
    if (contenders.length === 1) { this.resolveShowdownOrFold(); return {}; }

    if (raiseHappened) {
      const idx = this.seatIndexOf(playerId);
      this.toActQueue = [];
      let i = idx;
      for (let step = 0; step < this.players.length; step++) {
        i = (i + 1) % this.players.length;
        const pl = this.players[i];
        if (pl.inHand && !pl.folded && !pl.allIn && pl.id !== playerId) this.toActQueue.push(pl.id);
      }
    } else {
      this.toActQueue = this.toActQueue.filter((id) => id !== playerId);
    }

    if (this.toActQueue.length === 0) { this.actingId = null; this.advanceStage(); }
    else this.actingId = this.toActQueue[0];

    return {};
  }

  // Chamado pelo tick do servidor quando um jogador estourou o tempo
  // total (30s + 10s de tolerância) sem agir. Se dá pra passar de graça,
  // passa — senão desiste, e fica marcado "ausente" na mesa até agir de
  // novo por conta própria.
  autoTimeoutAction(playerId) {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p || this.actingId !== playerId) return;
    const toCall = this.currentBet - p.roundBet;
    if (toCall > 0) {
      this.applyAction(playerId, "fold");
      p.away = true; // aplica DEPOIS — applyAction sempre zera away no início
    } else {
      this.applyAction(playerId, "check");
    }
  }

  advanceStage() {
    this.players.forEach((p) => { p.roundBet = 0; });
    const contenders = activeInHand(this.players);
    const stillNeedAction = needMoreAction(this.players);

    if (this.stage === "preflop" || this.stage === "flop" || this.stage === "turn") {
      const order = { preflop: "flop", flop: "turn", turn: "river" };
      const nextStage = order[this.stage];
      const dealCount = nextStage === "flop" ? 3 : 1;
      for (let i = 0; i < dealCount; i++) this.community.push(this.deck.pop());
      this.stage = nextStage;
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      this.addLog(`${nextStage === "flop" ? "Flop" : nextStage === "turn" ? "Turn" : "Rio"}: ${this.community.map((c) => c.rank + c.suit).join(" ")}`);

      if (contenders.length > 1 && stillNeedAction) {
        const dealerIdx = this.seatIndexOf(this.dealerId);
        const actor = nextToActSeat(this.players, dealerIdx);
        this.toActQueue = actor === -1 ? [] : this.buildActOrder(actor);
        this.actingId = this.toActQueue[0] ?? null;
      } else {
        this.actingId = null;
        if (contenders.length > 1) {
          // Ninguém mais pode agir (todo mundo all-in) — a partir de agora
          // as cartas ficam visíveis pra todo mundo mesmo antes do "showdown"
          // literal, exatamente como numa mesa de verdade: revela as mãos e
          // só então continua rodando as próximas cartas da mesa.
          this.allInRunout = true;
          // % de vitória recalculada a cada carta que sai, igual às
          // transmissões de poker — reduz conforme menos cartas ficam
          // desconhecidas.
          this.winProbs = computeWinProbs(contenders, this.community, this.variant);
        }
        if (this.stage === "river") {
          // No more betting possible (everyone left is all-in) and we
          // just dealt the last card — go straight to showdown instead
          // of waiting for another auto-runout tick that will never come.
          this.resolveShowdownOrFold();
        }
        // otherwise: caller (index.js) re-invokes advanceStage after a
        // short delay to deal the next street automatically.
      }
    } else if (this.stage === "river") {
      this.resolveShowdownOrFold();
    }
  }

  resolveShowdownOrFold() {
    const contenders = activeInHand(this.players);
    const tags = {};
    this.pendingRake = 0;
    this.pendingPlatformRake = 0;
    this.pendingJackpotEvent = null;
    this.pendingJackpotDealtIds = [];
    // Quanto rake cada jogador "gerou" nessa mão — proporcional ao que
    // ele colocou no(s) pote(s) raked, mesmo se desistiu (o dinheiro dele
    // continua fazendo parte do pote que foi taxado). Base de tudo que
    // vem depois (rakeback do membro, comissão do agente).
    this.pendingRakeByPlayer = {};
    if (contenders.length === 1) {
      const winner = contenders[0];
      const totalPot = this.players.reduce((s, p) => s + p.totalBet, 0);
      winner.chips += totalPot;
      tags[winner.id] = `+${totalPot}`;
      this.addLog(`${winner.name} vence a mão sem showdown (todos desistiram).`);
    } else {
      const pots = computePots(this.players);
      const scored = {};
      contenders.forEach((p) => { scored[p.id] = bestHandFor(p.cards, this.community, this.variant); });
      // Detecta Cooler/Mão Forte pra essa mão — só a detecção pura aqui;
      // quem decide se paga (jackpot ligado? qual tipo? qual %?) e quem
      // efetivamente credita as fichas é o index.js, logo depois de
      // broadcastar essa mesma resolução (ele já sabe o clube).
      const holeCardsById = {};
      contenders.forEach((p) => { holeCardsById[p.id] = p.cards; });
      this.pendingJackpotEvent = detectJackpotEvent(scored, contenders.map((p) => p.id), holeCardsById, this.variant);
      this.pendingJackpotDealtIds = Object.keys(this.handStartChips || {});
      // As 5 cartas exatas que formaram a mão de quem ganhou algum pote —
      // pra UI acender um brilho só nelas (nas cartas na mão do jogador E
      // no board), igual pedido: "mostre a animação das cartas usadas
      // brilhando pra todo mundo ver o que aquele player fez".
      this.winningHandCards = {};
      pots.forEach((potObj, idx) => {
        let bestScore = null, winners = [];
        potObj.eligible.forEach((id) => {
          const s = scored[id];
          if (!bestScore || compareScores(s, bestScore) > 0) { bestScore = s; winners = [id]; }
          else if (compareScores(s, bestScore) === 0) winners.push(id);
        });
        // Standard "rake the pot" convention: only pots that reach a real
        // showdown (not everyone-folds-preflop) get raked, and the rake
        // is taken off the top before splitting among winners. Todo o
        // rake é do CLUBE — não existe mais fatia pro app.
        // "Teto" da tela de criar mesa: por mais que o % dê um valor
        // maior, nunca tira mais que rakeCapBb big blinds desse pote.
        const rakeCapChips = this.rakeCapBb > 0 ? Math.floor(this.rakeCapBb * this.bigBlind) : Infinity;
        const rakeAmount = this.rakePercent > 0 ? Math.min(Math.floor((potObj.amount * this.rakePercent) / 100), rakeCapChips) : 0;
        const distributable = potObj.amount - rakeAmount;
        this.pendingRake += rakeAmount;
        if (rakeAmount > 0) {
          const contributorIds = Object.keys(potObj.contributions);
          let assigned = 0;
          contributorIds.forEach((id, i) => {
            const isLast = i === contributorIds.length - 1;
            const share = isLast ? rakeAmount - assigned : Math.floor((potObj.contributions[id] / potObj.amount) * rakeAmount);
            assigned += share;
            if (share > 0) this.pendingRakeByPlayer[id] = (this.pendingRakeByPlayer[id] || 0) + share;
          });
        }
        const share = Math.floor(distributable / winners.length);
        let remainder = distributable - share * winners.length;
        winners.forEach((id) => {
          const pl = this.players.find((p) => p.id === id);
          let amt = share; if (remainder > 0) { amt += 1; remainder -= 1; }
          pl.chips += amt;
          tags[id] = (tags[id] ? tags[id] + " + " : "+") + amt;
          if (scored[id]?.cards) this.winningHandCards[id] = scored[id].cards;
        });
        const label = pots.length > 1 ? (idx === 0 ? "Pote principal" : `Side pot ${idx}`) : "Pote";
        const names = winners.map((id) => this.players.find((p) => p.id === id).name).join(", ");
        const rakeNote = rakeAmount > 0 ? ` (rake: ${rakeAmount})` : "";
        this.addLog(`${label} (${potObj.amount}${rakeNote}): ${names} vence com ${CATEGORY_NAMES[bestScore.category]}.`);
      });
      // Trava a % de vitória no resultado real (100 pra quem ganhou algum
      // pote, 0 pra quem não ganhou nada) — evita mostrar uma estimativa
      // desatualizada depois que a mão já foi decidida de verdade.
      this.winProbs = {};
      contenders.forEach((p) => { this.winProbs[p.id] = tags[p.id] ? 100 : 0; });
    }
    this.results = tags;
    this.stage = "showdown";
    this.actingId = null;
    // Ganho/perda líquido de cada jogador que começou a mão, pra
    // alimentar a Carreira (só quem tinha fichas registradas no início).
    this.lastHandDeltas = {};
    // Snapshot de VPIP dessa mão — pra "Nv. de VPIP" poder contar mãos
    // jogadas mesmo pra quem desistiu sem nunca pagar nada (não conta
    // VPIP), e pro dono decidir remover quem tá jogando apertado demais.
    this.lastHandVpip = {};
    Object.keys(this.handStartChips || {}).forEach((id) => {
      const p = this.players.find((pl) => pl.id === id);
      if (!p) return;
      const delta = p.chips - this.handStartChips[id];
      if (delta !== 0) this.lastHandDeltas[id] = delta;
      this.lastHandVpip[id] = !!p.vpipThisHand;
    });
    this.recordHandHistorySnapshot(contenders);
  }

  // Guarda um retrato completo da mão que acabou de terminar — board,
  // cartas de quem foi a showdown (escondidas de quem só desistiu, igual
  // uma mesa de verdade), posição, resultado líquido — pra tela de
  // "Detalhes das mãos" estilo PPPoker. Mantém só as últimas 50 (a mesa
  // não precisa carregar histórico eterno na memória).
  recordHandHistorySnapshot(contenders) {
    const contenderIds = new Set((contenders || []).map((p) => p.id));
    const dealerIdx = this.players.findIndex((p) => p.id === this.dealerId);
    const n = this.players.length;
    const posName = (offsetFromDealer) => {
      if (offsetFromDealer === 0) return "BTN";
      if (offsetFromDealer === 1) return n === 2 ? "BB" : "SB";
      if (offsetFromDealer === 2) return n === 2 ? undefined : "BB";
      const laterNames = ["UTG", "UTG+1", "UTG+2", "MP", "MP+1", "HJ", "CO"];
      const idx = offsetFromDealer - 3;
      return laterNames[Math.min(idx, laterNames.length - 1)];
    };
    const players = Object.keys(this.handStartChips || {}).map((id) => {
      const p = this.players.find((pl) => pl.id === id);
      const seatIdx = this.players.findIndex((pl) => pl.id === id);
      const offset = dealerIdx >= 0 && seatIdx >= 0 ? (seatIdx - dealerIdx + n) % n : null;
      return {
        id, name: p ? p.name : id,
        position: offset != null ? posName(offset) : null,
        // "Ver Cartas Descartadas": mesa configurada pra revelar as
        // cartas de quem desistiu, mas só DEPOIS da mão acabar (aqui é
        // sempre pós-mão) — nunca durante o jogo, isso vazaria
        // informação viva. Quando desligado, comportamento de sempre.
        cards: contenderIds.has(id) ? (p ? p.cards : null) : (this.revealFoldedCards && p ? p.cards : null),
        handLabel: contenderIds.has(id) && p ? (CATEGORY_NAMES[bestHandFor(p.cards, this.community, this.variant)?.category] || null) : null,
        delta: this.lastHandDeltas[id] || 0,
      };
    });
    this.handHistory = this.handHistory || [];
    this.handHistory.unshift({
      id: (this.handHistory[0]?.id || 0) + 1,
      at: new Date().toISOString(),
      smallBlind: this.smallBlind, bigBlind: this.bigBlind,
      community: this.community,
      players,
    });
    if (this.handHistory.length > 50) this.handHistory.length = 50;
  }

  // "Dividir EV": se der pra oferecer o chop (ver eligibleForSplitEv),
  // resolve a mão AGORA por equidade em vez de continuar revelando
  // cartas — cada jogador recebe a fatia de cada pote proporcional à
  // sua chance de ganhar, sem depender de qual carta sai depois. É uma
  // resolução PRÓPRIA (não usa resolveShowdownOrFold) justamente pra não
  // arriscar misturar dois jeitos diferentes de fechar pote na mesma
  // função — mais fácil de revisar separado.
  eligibleForSplitEv() {
    if (!this.splitEv) return false;
    if (this.stage === "idle" || this.stage === "showdown" || this.community.length >= 5) return false;
    const live = this.players.filter((p) => p.inHand && !p.folded);
    if (live.length < 2) return false;
    if (!live.every((p) => p.allIn || p.chips === 0)) return false;
    const potTotal = this.players.reduce((s, p) => s + p.totalBet, 0);
    return potTotal >= 10 * this.bigBlind;
  }

  settleBySplitEv() {
    const live = this.players.filter((p) => p.inHand && !p.folded);
    const pots = computePots(this.players);
    const tags = {};
    pots.forEach((potObj) => {
      const eligible = live.filter((p) => potObj.eligible.includes(p.id));
      if (eligible.length === 0) return;
      // Taxa própria do Dividir EV: 3% do pote, igual a fórmula do
      // documento (Pot - Taxa) × Equidade × 97% — aqui já aplicada como
      // um fator direto no valor total antes de repartir.
      const distributable = Math.floor(potObj.amount * 0.97);
      if (eligible.length === 1) {
        eligible[0].chips += distributable;
        tags[eligible[0].id] = (tags[eligible[0].id] || 0) + distributable;
        return;
      }
      const eq = computeEquityFractions(eligible, this.community, this.variant);
      let given = 0;
      eligible.forEach((p, i) => {
        const isLast = i === eligible.length - 1;
        const share = isLast ? (distributable - given) : Math.floor(distributable * (eq[p.id] || 0));
        p.chips += share;
        given += share;
        tags[p.id] = (tags[p.id] || 0) + share;
      });
    });
    this.results = Object.fromEntries(Object.entries(tags).map(([id, amt]) => [id, `+${amt} (EV)`]));
    this.addLog("Dividir EV: pote resolvido por equidade, sem esperar o resto do board.");
    this.lastHandDeltas = {};
    this.lastHandVpip = {};
    Object.keys(this.handStartChips || {}).forEach((id) => {
      const p = this.players.find((pl) => pl.id === id);
      if (!p) return;
      const delta = p.chips - this.handStartChips[id];
      if (delta !== 0) this.lastHandDeltas[id] = delta;
      this.lastHandVpip[id] = !!p.vpipThisHand;
    });
    this.recordHandHistorySnapshot(live);
    this.actingId = null;
    this.toActQueue = [];
    this.stage = "showdown"; // mesma pausa visual de sempre antes da próxima mão
    this.allInRunout = false;
  }

  needsAutoRunout() {
    if (this.actingId !== null) return false;
    // "river" faltava aqui — sem ele, uma mão que vai all-in cedo (todo
    // mundo sem mais decisão a tomar) ficava TRAVADA pra sempre bem no
    // river, nunca chegando no showdown de verdade. Bug crítico: nenhuma
    // mão de all-in completo (antes do river) nunca terminava.
    return this.stage === "flop" || this.stage === "turn" || this.stage === "river" || this.stage === "preflop";
  }

  // Public view: hides other players' hole cards unless it's showdown.
  getPublicState(forPlayerId) {
    if (this.seeInAction) {
      if (!this._seenCards) this._seenCards = new Set();
      if (this.actingId) this._seenCards.add(this.actingId);
    }
    const cfg = variantConfig(this.variant);
    return {
      stage: this.stage,
      community: this.community,
      pot: this.pot,
      // Quebra do pote em potes separados quando alguém já foi all-in por
      // menos (side pot) — cada um com seu valor e quem ainda disputa
      // ele, pra UI mostrar montinhos distintos em vez de um só
      // aglomerado (nem todo mundo disputa todo pote).
      pots: this.pot > 0 ? computePots(this.players) : [],
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      actingId: this.actingId,
      dealerId: this.dealerId,
      allInRunout: !!this.allInRunout,
      winProbs: this.winProbs || {},
      results: this.results,
      // Cartas exatas de quem ganhou algum pote nessa mão (5 cartas cada)
      // — a UI usa isso pra acender um brilho só nelas, no board e na mão
      // do vencedor, pra todo mundo ver o que ele fez.
      winningHandCards: this.winningHandCards || {},
      // Resultado em tempo real (+/-) de cada jogador que passou por essa
      // mesa — inclui quem já saiu (finalChips congelado no momento em
      // que levantou), pra manter o histórico completo da mesa.
      sessionStats: Object.entries(this.sessionStats || {}).map(([id, s]) => {
        const p = this.players.find((pl) => pl.id === id);
        const currentChips = p ? p.chips : s.finalChips;
        return { id, name: s.name || id, buyIn: s.buyIn, delta: (currentChips ?? s.buyIn) - s.buyIn, active: !!p };
      }),
      log: this.log,
      isTournament: !!this.isTournament,
      tournamentId: this.tournamentId || null,
      tournamentBuyIn: this.tournamentBuyIn || null,
      tournamentStartingChips: this.tournamentStartingChips || null,
      tournamentRebuyAllowed: !!this.tournamentRebuyAllowed,
      // Últimas mãos completas dessa mesa, com board + cartas de quem foi
      // a showdown (escondidas de quem só desistiu) — pra tela de
      // "Detalhes das mãos" estilo PPPoker.
      handHistory: this.handHistory || [],
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      variant: this.variant,
      maxSeats: this.maxSeats,
      actionSeconds: this.actionSeconds,
      // Pra UI saber quantas cartas mostrar antes de distribuir e se deve
      // aplicar o teto de Pot-Limit no slider — sem precisar hardcodar
      // "PLO4/5/6" em lugar nenhum do cliente também.
      holeCards: cfg.holeCards,
      bettingStructure: cfg.bettingStructure,
      // Teto de aposta pro jogador que está com a vez agora — a engine já
      // manda o valor pronto (Pot-Limit ou stack, dependendo da
      // variante); o cliente só exibe, nunca recalcula a regra sozinho.
      // Fica null quando não é a vez de ninguém agir.
      myMaxRaiseTotal: this.actingId ? this.getMaxRaiseTotal(this.actingId) : null,
      players: this.players.map((p) => {
        // Cartas ficam visíveis pro dono delas sempre, e pra todo mundo
        // durante all-in runout ou showdown (mesma regra de uma mesa real).
        // "Ver em ação" muda só a parte do DONO: fica escondida até
        // chegar a vez dele de jogar (this._seenCards é marcado logo
        // abaixo, toda vez que getPublicState roda com alguém agindo —
        // uma vez visto, continua visível o resto da mão, mesma lógica
        // de "já vi minhas cartas, não vou esquecer").
        const ownCardsHidden = this.seeInAction && this.stage !== "idle" && this.stage !== "showdown" && !this.allInRunout
          && p.id !== this.actingId && !this._seenCards?.has(p.id) && !p.folded;
        const cardsVisible = (p.id === forPlayerId && !ownCardsHidden) || ((this.stage === "showdown" || this.allInRunout) && !p.folded);
        const cards = cardsVisible ? p.cards : p.cards.map(() => null);
        // "Par", "Flush" etc ao lado do jogador — só calculado quando as
        // cartas dele já estão visíveis pra quem está olhando, e só a
        // partir do flop. bestHandFor já aplica a regra certa (Hold'em
        // livre, ou 2+3 forçado em Omaha) conforme a variante da mesa.
        let handLabel = null;
        if (cardsVisible && p.inHand && !p.folded && this.community.length >= 3) {
          const best = bestHandFor(p.cards, this.community, this.variant);
          if (best) handLabel = CATEGORY_NAMES[best.category];
        }
        return {
          id: p.id,
          name: p.name,
          chips: p.chips,
          folded: p.folded,
          allIn: p.allIn,
          roundBet: p.roundBet,
          inHand: p.inHand,
          connected: p.connected,
          isBot: !!p.isBot,
          away: !!p.away,
          seat: p.seat,
          cards,
          handLabel,
        };
      }),
    };
  }
}
