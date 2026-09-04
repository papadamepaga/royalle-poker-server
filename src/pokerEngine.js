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
  return { category, kickers };
}
export function compareScores(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < a.kickers.length; i++) {
    const diff = (a.kickers[i] || 0) - (b.kickers[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
    pots.push({ amount, eligible });
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

export class PokerTable {
  constructor({ smallBlind = 25, bigBlind = 50, rakePercent = 0, variant = "holdem" } = {}) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.rakePercent = rakePercent; // e.g. 5 means 5% of each pot
    this.variant = variant; // "holdem" | "plo4" | "plo5" | "plo6" (só holdem implementado por enquanto)
    this.players = []; // { id, name, chips, cards, folded, allIn, inHand, roundBet, totalBet, connected, isBot }
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
    this.pendingPlatformRake = 0; // chips raked (parte do APP) na mão mais recente, ainda não gravados pelo caller
    this.allInRunout = false;
    this.winProbs = {}; // { playerId: percentInteiro } — só preenchido durante all-in runout / showdown
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 30) this.log.shift();
  }

  addPlayer(id, name, chips, isBot = false) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({ id, name, chips, cards: [], folded: false, allIn: false, inHand: false, roundBet: 0, totalBet: 0, connected: true, isBot });
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
    this.players.forEach((p) => { if (p.chips > 0) this.handStartChips[p.id] = p.chips; });
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

    const firstActor = nextToActSeat(this.players, bbIdx);
    this.toActQueue = firstActor === -1 ? [] : this.buildActOrder(firstActor);
    this.actingId = this.toActQueue[0] ?? null;
    this.addLog(`Nova mão. ${sb.name} paga small blind (${sbAmt}), ${bb.name} paga big blind (${bbAmt}).`);
  }

  applyAction(playerId, action, amount) {
    if (this.actingId !== playerId) return { error: "Não é sua vez." };
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return { error: "Jogador não encontrado." };

    let raiseHappened = false;
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
        const rakeAmount = this.rakePercent > 0 ? Math.floor((potObj.amount * this.rakePercent) / 100) : 0;
        const distributable = potObj.amount - rakeAmount;
        this.pendingRake += rakeAmount;
        const share = Math.floor(distributable / winners.length);
        let remainder = distributable - share * winners.length;
        winners.forEach((id) => {
          const pl = this.players.find((p) => p.id === id);
          let amt = share; if (remainder > 0) { amt += 1; remainder -= 1; }
          pl.chips += amt;
          tags[id] = (tags[id] ? tags[id] + " + " : "+") + amt;
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
    Object.keys(this.handStartChips || {}).forEach((id) => {
      const p = this.players.find((pl) => pl.id === id);
      if (!p) return;
      const delta = p.chips - this.handStartChips[id];
      if (delta !== 0) this.lastHandDeltas[id] = delta;
    });
  }

  needsAutoRunout() {
    if (this.actingId !== null) return false;
    return this.stage === "flop" || this.stage === "turn" || this.stage === "preflop";
  }

  // Public view: hides other players' hole cards unless it's showdown.
  getPublicState(forPlayerId) {
    const cfg = variantConfig(this.variant);
    return {
      stage: this.stage,
      community: this.community,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      actingId: this.actingId,
      dealerId: this.dealerId,
      allInRunout: !!this.allInRunout,
      winProbs: this.winProbs || {},
      results: this.results,
      log: this.log,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      variant: this.variant,
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
        const cardsVisible = p.id === forPlayerId || ((this.stage === "showdown" || this.allInRunout) && !p.folded);
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
          cards,
          handLabel,
        };
      }),
    };
  }
}
