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
function evaluate5(cards) {
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
function compareScores(a, b) {
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
    this.pendingRake = 0; // chips raked in the most recently completed hand, not yet recorded by the caller
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

  startHand() {
    if (this.players.filter((p) => p.chips > 0).length < 2) {
      this.addLog("Fichas insuficientes na mesa pra continuar.");
      return;
    }
    this.deck = shuffle(freshDeck());
    this.players.forEach((p) => {
      p.cards = []; p.folded = false; p.allIn = false; p.inHand = p.chips > 0; p.roundBet = 0; p.totalBet = 0;
    });
    const dealerIdx = this.dealerId === null ? 0 : nextRotationSeat(this.players, this.seatIndexOf(this.dealerId));
    this.dealerId = this.players[dealerIdx].id;
    this.players.forEach((p) => { if (p.inHand) p.cards = [this.deck.pop(), this.deck.pop()]; });

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
      const targetTotal = action === "allin" ? p.roundBet + p.chips : Math.min(amount, p.roundBet + p.chips);
      const delta = targetTotal - p.roundBet;
      if (delta <= 0) return { error: "Valor de aumento inválido." };
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
    if (contenders.length === 1) {
      const winner = contenders[0];
      const totalPot = this.players.reduce((s, p) => s + p.totalBet, 0);
      winner.chips += totalPot;
      tags[winner.id] = `+${totalPot}`;
      this.addLog(`${winner.name} vence a mão sem showdown (todos desistiram).`);
    } else {
      const pots = computePots(this.players);
      const scored = {};
      contenders.forEach((p) => { scored[p.id] = bestOf7([...p.cards, ...this.community]); });
      pots.forEach((potObj, idx) => {
        let bestScore = null, winners = [];
        potObj.eligible.forEach((id) => {
          const s = scored[id];
          if (!bestScore || compareScores(s, bestScore) > 0) { bestScore = s; winners = [id]; }
          else if (compareScores(s, bestScore) === 0) winners.push(id);
        });
        // Standard "rake the pot" convention: only pots that reach a real
        // showdown (not everyone-folds-preflop) get raked, and the rake
        // is taken off the top before splitting among winners.
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
    }
    this.results = tags;
    this.stage = "showdown";
    this.actingId = null;
  }

  needsAutoRunout() {
    if (this.actingId !== null) return false;
    return this.stage === "flop" || this.stage === "turn" || this.stage === "preflop";
  }

  // Public view: hides other players' hole cards unless it's showdown.
  getPublicState(forPlayerId) {
    return {
      stage: this.stage,
      community: this.community,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      actingId: this.actingId,
      dealerId: this.dealerId,
      results: this.results,
      log: this.log,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      variant: this.variant,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        folded: p.folded,
        allIn: p.allIn,
        roundBet: p.roundBet,
        inHand: p.inHand,
        connected: p.connected,
        isBot: !!p.isBot,
        cards:
          p.id === forPlayerId || this.stage === "showdown" && !p.folded
            ? p.cards
            : p.cards.map(() => null),
      })),
    };
  }
}
