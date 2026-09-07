import { pool, hasDatabase } from "./db.js";

// ---------------------------------------------------------------------
// Thin data-access layer. When DATABASE_URL isn't set (e.g. quick local
// testing without Postgres installed), we transparently fall back to an
// in-memory version of the same functions so the rest of the server
// doesn't need to know which backend it's talking to.
// ---------------------------------------------------------------------

export const AVATAR_OPTIONS = ["avatar_01", "avatar_02", "avatar_03"];

// ---- in-memory fallback ----
const mem = {
  users: [], // {id, username, password_hash, avatar}
  clubs: [], // {id, code, name, owner_id, small_blind, big_blind, buy_in, rake_percent}
  members: [], // {club_id, user_id, chips, role}
  rake: [], // {club_id, amount, created_at}
  quickWallets: [], // {user_id, chips, gems, last_daily_claim}
  userStats: [], // {user_id, hands_played, hands_won}
  clubTables: [], // {id, club_id, variant, small_blind, big_blind, buy_in, rake_percent, max_players}
  payLedger: [], // {id, club_id, user_id, admin_id, type, amount, balance_before, balance_after, created_at}
  joinRequests: [], // {id, club_id, user_id}
  announcements: [], // {id, version, title, body, created_at}
  notifications: [], // {id, user_id, club_id, title, body, created_at}
  handLedger: [], // {id, club_id, table_id, user_id, delta, created_at}
  tournaments: [], // {id, club_id, name, variant, buy_in, starting_chips, max_players, min_players, blind_structure, level_minutes, late_reg_minutes, rebuy_allowed, rebuy_max, gtd_prize, start_time, created_by, status, current_level, level_started_at, finished_at, created_at}
  tournamentEntries: [], // {id, tournament_id, user_id, status, chips, rebuys, rank, prize, eliminated_at, registered_at}
  agentWallets: [], // {id, club_id, user_id, status, created_at}
  commissionRateHistory: [], // {id, agent_wallet_id, rate_percent, effective_from, set_by, created_at}
  rakebackRateHistory: [], // {id, club_id, member_user_id, rate_percent, effective_from, set_by, created_at}
  agentMemberLinks: [], // {id, club_id, member_user_id, agent_wallet_id, linked_from, linked_until, changed_by, created_at}
  rakeEvents: [], // {id, club_id, member_user_id, table_code, gross_amount, rakeback_rate, rakeback_amount, net_amount, agent_wallet_id, commission_rate, commission_amount, club_result, closing_id, created_at}
  rakeClosings: [], // {id, club_id, type, period_start, period_end, closed_at, closed_by, gross_rake, rakeback_total, commission_total, club_result, status}
  nextUserId: 1,
  nextClubId: 1,
  nextClubTableId: 1,
  nextLedgerId: 1,
  nextJoinRequestId: 1,
  nextAnnouncementId: 1,
  nextNotificationId: 1,
  nextHandLedgerId: 1,
  nextTournamentId: 1,
  nextTournamentEntryId: 1,
  nextAgentWalletId: 1,
  nextCommissionRateId: 1,
  nextRakebackRateId: 1,
  nextAgentMemberLinkId: 1,
  nextRakeEventId: 1,
  nextRakeClosingId: 1,
};

const QUICK_WALLET_START = 10000;
const DAILY_BONUS_AMOUNT = 5000;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Carteira avulsa usada só pelas mesas públicas de "Jogar" (matchmaking por
// tipo de jogo, fora de qualquer clube). Totalmente separada do saldo de
// fichas de clube. Essa é a "Royalle Coin".
export async function getOrCreateQuickWallet(userId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO quick_wallets (user_id, chips) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING RETURNING chips, gems, last_daily_claim`,
      [userId, QUICK_WALLET_START]
    );
    if (rows[0]) return { chips: rows[0].chips, gems: Number(rows[0].gems), lastDailyClaim: rows[0].last_daily_claim };
    const existing = await pool.query("SELECT chips, gems, last_daily_claim FROM quick_wallets WHERE user_id = $1", [userId]);
    const r = existing.rows[0];
    return r ? { chips: r.chips, gems: Number(r.gems), lastDailyClaim: r.last_daily_claim } : { chips: QUICK_WALLET_START, gems: 0, lastDailyClaim: null };
  }
  let w = mem.quickWallets.find((w) => w.user_id === userId);
  if (!w) { w = { user_id: userId, chips: QUICK_WALLET_START, gems: 0, last_daily_claim: null }; mem.quickWallets.push(w); }
  return { chips: w.chips, gems: w.gems || 0, lastDailyClaim: w.last_daily_claim };
}

export async function adjustQuickWalletChips(userId, delta) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO quick_wallets (user_id, chips) VALUES ($1, GREATEST($2 + $3, 0))
       ON CONFLICT (user_id) DO UPDATE SET chips = GREATEST(quick_wallets.chips + $3, 0)
       RETURNING chips`,
      [userId, QUICK_WALLET_START, delta]
    );
    return rows[0].chips;
  }
  let w = mem.quickWallets.find((w) => w.user_id === userId);
  if (!w) { w = { user_id: userId, chips: QUICK_WALLET_START, last_daily_claim: null }; mem.quickWallets.push(w); }
  w.chips = Math.max(0, w.chips + delta);
  return w.chips;
}

// Mesma ideia, pra diamantes (gems) — usado quando o dono compra um
// Clube Nível (paga em diamante, não em ficha).
export async function adjustQuickWalletGems(userId, delta) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO quick_wallets (user_id, gems) VALUES ($1, GREATEST($2, 0))
       ON CONFLICT (user_id) DO UPDATE SET gems = GREATEST(quick_wallets.gems + $2, 0)
       RETURNING gems`,
      [userId, delta]
    );
    return Number(rows[0].gems);
  }
  let w = mem.quickWallets.find((w) => w.user_id === userId);
  if (!w) { w = { user_id: userId, chips: QUICK_WALLET_START, gems: 0, last_daily_claim: null }; mem.quickWallets.push(w); }
  w.gems = Math.max(0, (w.gems || 0) + delta);
  return w.gems;
}

// Bônus diário de Royalle Coin — 1 resgate por usuário por dia (data do
// servidor, UTC). Retorna { claimed, chips }; claimed=false se já resgatou
// hoje (chips retornado é o saldo atual, sem alteração).
export async function claimDailyBonus(userId) {
  const today = todayStr();
  if (hasDatabase) {
    await pool.query(`INSERT INTO quick_wallets (user_id, chips) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, QUICK_WALLET_START]);
    const { rows } = await pool.query(
      `UPDATE quick_wallets SET chips = chips + $2, last_daily_claim = $3
       WHERE user_id = $1 AND (last_daily_claim IS NULL OR last_daily_claim <> $3)
       RETURNING chips`,
      [userId, DAILY_BONUS_AMOUNT, today]
    );
    if (rows[0]) return { claimed: true, chips: rows[0].chips };
    const current = await pool.query("SELECT chips FROM quick_wallets WHERE user_id = $1", [userId]);
    return { claimed: false, chips: current.rows[0]?.chips ?? QUICK_WALLET_START };
  }
  let w = mem.quickWallets.find((w) => w.user_id === userId);
  if (!w) { w = { user_id: userId, chips: QUICK_WALLET_START, last_daily_claim: null }; mem.quickWallets.push(w); }
  if (w.last_daily_claim === today) return { claimed: false, chips: w.chips };
  w.chips += DAILY_BONUS_AMOUNT;
  w.last_daily_claim = today;
  return { claimed: true, chips: w.chips };
}

export async function updateUserAvatar(userId, avatar) {
  if (hasDatabase) {
    // Escolher um avatar de emoji preset limpa qualquer foto customizada
    // enviada antes — só um dos dois fica valendo por vez.
    await pool.query("UPDATE users SET avatar = $1, avatar_image = NULL WHERE id = $2", [avatar, userId]);
    return;
  }
  const u = mem.users.find((u) => u.id === userId);
  if (u) { u.avatar = avatar; u.avatar_image = null; }
}

// Foto de perfil enviada do próprio dispositivo (base64) — passar null
// remove a foto customizada e volta a mostrar o avatar de emoji preset.
export async function updateUserAvatarImage(userId, avatarImage) {
  if (hasDatabase) {
    await pool.query("UPDATE users SET avatar_image = $1 WHERE id = $2", [avatarImage, userId]);
    return;
  }
  const u = mem.users.find((u) => u.id === userId);
  if (u) u.avatar_image = avatarImage;
}

// Renomeia o jogador — confere se o nome já não está em uso (case-
// insensitive) por outra conta antes de gravar.
export async function renameUser(userId, newUsername) {
  if (hasDatabase) {
    const clash = await pool.query("SELECT id FROM users WHERE lower(username) = lower($1) AND id <> $2", [newUsername, userId]);
    if (clash.rows.length > 0) return { ok: false, error: "Esse nome já está em uso." };
    await pool.query("UPDATE users SET username = $1 WHERE id = $2", [newUsername, userId]);
    return { ok: true };
  }
  const clash = mem.users.find((u) => u.username.toLowerCase() === newUsername.toLowerCase() && u.id !== userId);
  if (clash) return { ok: false, error: "Esse nome já está em uso." };
  const u = mem.users.find((u) => u.id === userId);
  if (u) u.username = newUsername;
  return { ok: true };
}

// Foto/logo do clube (base64) — só o dono/agente chama isso; passar null
// remove a foto e volta a mostrar o ícone de coroa padrão.
export async function updateClubImage(clubId, image) {
  if (hasDatabase) {
    await pool.query("UPDATE clubs SET image = $1 WHERE id = $2", [image, clubId]);
    return;
  }
  const c = mem.clubs.find((c) => c.id === clubId);
  if (c) c.image = image;
}

// Capa do cabeçalho do clube (banner), separada do logo — mesma lógica.
export async function updateClubCoverImage(clubId, image) {
  if (hasDatabase) {
    await pool.query("UPDATE clubs SET cover_image = $1 WHERE id = $2", [image, clubId]);
    return;
  }
  const c = mem.clubs.find((c) => c.id === clubId);
  if (c) c.cover_image = image;
}

// Nível do clube — compra por 30 dias, dá mais capacidade de
// membros/gestores. Salva sempre a partir de agora (não empilha tempo
// restante de uma compra anterior).
export async function setClubLevel(clubId, level) {
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  if (hasDatabase) {
    await pool.query("UPDATE clubs SET level = $1, level_expires_at = $2 WHERE id = $3", [level, expiresAt, clubId]);
    return expiresAt;
  }
  const c = mem.clubs.find((c) => c.id === clubId);
  if (c) { c.level = level; c.level_expires_at = expiresAt; }
  return expiresAt;
}

// Muda o papel de um membro (member <-> agent) — usado pra promover/
// rebaixar gestor. Só o dono chama isso (checado no index.js).
export async function setMemberRole(clubId, userId, role) {
  if (hasDatabase) {
    await pool.query("UPDATE club_members SET role = $1 WHERE club_id = $2 AND user_id = $3", [role, clubId, userId]);
    return;
  }
  const m = mem.members.find((m) => m.club_id === clubId && m.user_id === userId);
  if (m) m.role = role;
}

export async function getUserStats(userId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT hands_played, hands_won FROM user_stats WHERE user_id = $1", [userId]);
    return rows[0] || { hands_played: 0, hands_won: 0 };
  }
  return mem.userStats.find((s) => s.user_id === userId) || { hands_played: 0, hands_won: 0 };
}

export async function recordHandStat(userId, won) {
  if (hasDatabase) {
    await pool.query(
      `INSERT INTO user_stats (user_id, hands_played, hands_won) VALUES ($1, 1, $2)
       ON CONFLICT (user_id) DO UPDATE SET hands_played = user_stats.hands_played + 1, hands_won = user_stats.hands_won + $2`,
      [userId, won ? 1 : 0]
    );
    return;
  }
  let s = mem.userStats.find((s) => s.user_id === userId);
  if (!s) { s = { user_id: userId, hands_played: 0, hands_won: 0 }; mem.userStats.push(s); }
  s.hands_played += 1;
  if (won) s.hands_won += 1;
}

// ---- mesas configuráveis dentro de um clube (Royalle Pay) ----

export async function listClubTables(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM club_tables WHERE club_id = $1 ORDER BY id ASC", [clubId]);
    return rows;
  }
  return mem.clubTables.filter((t) => t.club_id === clubId);
}

export async function createClubTable({ clubId, variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers }) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO club_tables (club_id, variant, small_blind, big_blind, buy_in, rake_percent, max_players)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [clubId, variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers]
    );
    return rows[0];
  }
  const t = { id: mem.nextClubTableId++, club_id: clubId, variant, small_blind: smallBlind, big_blind: bigBlind, buy_in: buyIn, rake_percent: rakePercent, max_players: maxPlayers };
  mem.clubTables.push(t);
  return t;
}

export async function getClubTableById(clubId, tableId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM club_tables WHERE id = $1 AND club_id = $2", [tableId, clubId]);
    return rows[0] || null;
  }
  return mem.clubTables.find((t) => t.id === Number(tableId) && t.club_id === clubId) || null;
}

export async function updateClubTable(clubId, tableId, { variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers }) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `UPDATE club_tables SET variant=$3, small_blind=$4, big_blind=$5, buy_in=$6, rake_percent=$7, max_players=$8
       WHERE id=$1 AND club_id=$2 RETURNING *`,
      [tableId, clubId, variant, smallBlind, bigBlind, buyIn, rakePercent, maxPlayers]
    );
    return rows[0] || null;
  }
  const t = mem.clubTables.find((t) => t.id === Number(tableId) && t.club_id === clubId);
  if (!t) return null;
  Object.assign(t, { variant, small_blind: smallBlind, big_blind: bigBlind, buy_in: buyIn, rake_percent: rakePercent, max_players: maxPlayers });
  return t;
}

export async function deleteClubTable(clubId, tableId) {
  if (hasDatabase) {
    await pool.query("DELETE FROM club_tables WHERE id=$1 AND club_id=$2", [tableId, clubId]);
    return;
  }
  mem.clubTables = mem.clubTables.filter((t) => !(t.id === Number(tableId) && t.club_id === clubId));
}

// ---- torneios (MTT) ----

export async function createTournament(cfg) {
  const {
    clubId, name, variant, buyIn, startingChips, maxPlayers, minPlayers,
    blindStructure, levelMinutes, lateRegMinutes, rebuyAllowed, rebuyMax,
    gtdPrize, startTime, createdBy,
    earlyBirdDiscountPct = 0, earlyBirdDeadline = null,
    bountyEnabled = false, bountyPercent = 50, payoutPercent = 12,
  } = cfg;
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO tournaments (club_id, name, variant, buy_in, starting_chips, max_players, min_players,
         blind_structure, level_minutes, late_reg_minutes, rebuy_allowed, rebuy_max, gtd_prize, start_time, created_by,
         early_bird_discount_pct, early_bird_deadline, bounty_enabled, bounty_percent, payout_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [clubId, name, variant, buyIn, startingChips, maxPlayers, minPlayers,
        blindStructure, levelMinutes, lateRegMinutes, rebuyAllowed, rebuyMax, gtdPrize, startTime, createdBy,
        earlyBirdDiscountPct, earlyBirdDeadline, bountyEnabled, bountyPercent, payoutPercent]
    );
    return rows[0];
  }
  const t = {
    id: mem.nextTournamentId++, club_id: clubId, name, variant, buy_in: buyIn, starting_chips: startingChips,
    max_players: maxPlayers, min_players: minPlayers, blind_structure: blindStructure, level_minutes: levelMinutes,
    late_reg_minutes: lateRegMinutes, rebuy_allowed: rebuyAllowed, rebuy_max: rebuyMax, gtd_prize: gtdPrize,
    start_time: startTime, created_by: createdBy, status: "scheduled", current_level: 0,
    level_started_at: null, finished_at: null, created_at: new Date().toISOString(),
    early_bird_discount_pct: earlyBirdDiscountPct, early_bird_deadline: earlyBirdDeadline,
    bounty_enabled: bountyEnabled, bounty_percent: bountyPercent, payout_percent: payoutPercent,
  };
  mem.tournaments.push(t);
  return t;
}

export async function listClubTournaments(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM tournaments WHERE club_id = $1 ORDER BY start_time DESC", [clubId]);
    return rows;
  }
  return mem.tournaments.filter((t) => t.club_id === clubId).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
}

// Todos os torneios "vivos" (ainda vão começar, ou já rodando) — usada
// pelo relógio do servidor (tickTournaments) pra saber quem precisa
// começar sozinho ou subir de nível de blind, sem precisar saber de
// antemão de qual clube é cada um.
export async function listActiveTournaments() {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM tournaments WHERE status IN ('scheduled','running')");
    return rows;
  }
  return mem.tournaments.filter((t) => t.status === "scheduled" || t.status === "running");
}

export async function getTournamentById(tournamentId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM tournaments WHERE id = $1", [tournamentId]);
    return rows[0] || null;
  }
  return mem.tournaments.find((t) => t.id === Number(tournamentId)) || null;
}

export async function updateTournament(tournamentId, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return getTournamentById(tournamentId);
  const colMap = {
    status: "status", currentLevel: "current_level", levelStartedAt: "level_started_at", finishedAt: "finished_at",
  };
  if (hasDatabase) {
    const setSql = cols.map((k, i) => `${colMap[k] || k} = $${i + 2}`).join(", ");
    const { rows } = await pool.query(`UPDATE tournaments SET ${setSql} WHERE id = $1 RETURNING *`, [tournamentId, ...cols.map((k) => fields[k])]);
    return rows[0] || null;
  }
  const t = mem.tournaments.find((t) => t.id === Number(tournamentId));
  if (!t) return null;
  for (const k of cols) t[colMap[k] || k] = fields[k];
  return t;
}

export async function listTournamentEntries(tournamentId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT e.*, u.username, u.avatar, u.avatar_image FROM tournament_entries e
       JOIN users u ON u.id = e.user_id WHERE e.tournament_id = $1 ORDER BY e.registered_at ASC`,
      [tournamentId]
    );
    return rows;
  }
  return mem.tournamentEntries
    .filter((e) => e.tournament_id === Number(tournamentId))
    .map((e) => {
      const u = mem.users.find((u) => u.id === e.user_id);
      return { ...e, username: u?.username, avatar: u?.avatar, avatar_image: u?.avatar_image || null };
    });
}

export async function getTournamentEntry(tournamentId, userId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM tournament_entries WHERE tournament_id = $1 AND user_id = $2", [tournamentId, userId]);
    return rows[0] || null;
  }
  return mem.tournamentEntries.find((e) => e.tournament_id === Number(tournamentId) && e.user_id === userId) || null;
}

export async function addTournamentEntry(tournamentId, userId, chips, buyInPaid) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO tournament_entries (tournament_id, user_id, chips, buy_in_paid) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tournament_id, user_id) DO NOTHING RETURNING *`,
      [tournamentId, userId, chips, buyInPaid]
    );
    return rows[0] || null;
  }
  if (mem.tournamentEntries.find((e) => e.tournament_id === Number(tournamentId) && e.user_id === userId)) return null;
  const e = {
    id: mem.nextTournamentEntryId++, tournament_id: Number(tournamentId), user_id: userId, status: "registered",
    chips, buy_in_paid: buyInPaid, rebuys: 0, rank: null, prize: 0, eliminated_at: null, registered_at: new Date().toISOString(),
  };
  mem.tournamentEntries.push(e);
  return e;
}

export async function removeTournamentEntry(tournamentId, userId) {
  if (hasDatabase) {
    await pool.query("DELETE FROM tournament_entries WHERE tournament_id = $1 AND user_id = $2", [tournamentId, userId]);
    return;
  }
  mem.tournamentEntries = mem.tournamentEntries.filter((e) => !(e.tournament_id === Number(tournamentId) && e.user_id === userId));
}

export async function updateTournamentEntry(tournamentId, userId, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  if (hasDatabase) {
    const setSql = cols.map((k, i) => `${k === "eliminatedAt" ? "eliminated_at" : k} = $${i + 3}`).join(", ");
    await pool.query(`UPDATE tournament_entries SET ${setSql} WHERE tournament_id = $1 AND user_id = $2`, [tournamentId, userId, ...cols.map((k) => fields[k])]);
    return;
  }
  const e = mem.tournamentEntries.find((e) => e.tournament_id === Number(tournamentId) && e.user_id === userId);
  if (!e) return;
  for (const k of cols) e[k === "eliminatedAt" ? "eliminated_at" : k] = fields[k];
}

// ---- histórico de Royalle Pay (envio/retirada pelo dono/admin) ----

export async function recordPayLedger({ clubId, userId, adminId, type, amount, balanceBefore, balanceAfter }) {
  if (hasDatabase) {
    await pool.query(
      `INSERT INTO pay_ledger (club_id, user_id, admin_id, type, amount, balance_before, balance_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [clubId, userId, adminId, type, amount, balanceBefore, balanceAfter]
    );
    return;
  }
  mem.payLedger.push({ id: mem.nextLedgerId++, club_id: clubId, user_id: userId, admin_id: adminId, type, amount, balance_before: balanceBefore, balance_after: balanceAfter, created_at: new Date().toISOString() });
}

export async function getPayHistory(clubId, userId = null) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT l.*, u.username, a.username AS admin_username
       FROM pay_ledger l
       JOIN users u ON u.id = l.user_id
       JOIN users a ON a.id = l.admin_id
       WHERE l.club_id = $1 ${userId ? "AND l.user_id = $2" : ""}
       ORDER BY l.created_at DESC LIMIT 200`,
      userId ? [clubId, userId] : [clubId]
    );
    return rows;
  }
  return mem.payLedger
    .filter((l) => l.club_id === clubId && (!userId || l.user_id === userId))
    .slice()
    .reverse()
    .map((l) => ({
      ...l,
      username: mem.users.find((u) => u.id === l.user_id)?.username,
      admin_username: mem.users.find((u) => u.id === l.admin_id)?.username,
    }));
}

// ---- solicitações de entrada em clube (aprovação do dono/admin) ----

export async function createJoinRequest(clubId, userId) {
  if (hasDatabase) {
    await pool.query(
      `INSERT INTO club_join_requests (club_id, user_id) VALUES ($1,$2) ON CONFLICT (club_id, user_id) DO NOTHING`,
      [clubId, userId]
    );
    return;
  }
  if (!mem.joinRequests.find((r) => r.club_id === clubId && r.user_id === userId)) {
    mem.joinRequests.push({ id: mem.nextJoinRequestId++, club_id: clubId, user_id: userId });
  }
}

export async function hasJoinRequest(clubId, userId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT 1 FROM club_join_requests WHERE club_id=$1 AND user_id=$2", [clubId, userId]);
    return rows.length > 0;
  }
  return !!mem.joinRequests.find((r) => r.club_id === clubId && r.user_id === userId);
}

export async function listJoinRequests(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT r.id, r.user_id, u.username, u.avatar, u.avatar_image, r.created_at
       FROM club_join_requests r JOIN users u ON u.id = r.user_id
       WHERE r.club_id = $1 ORDER BY r.created_at ASC`,
      [clubId]
    );
    return rows;
  }
  return mem.joinRequests
    .filter((r) => r.club_id === clubId)
    .map((r) => {
      const u = mem.users.find((u) => u.id === r.user_id);
      return { id: r.id, user_id: r.user_id, username: u?.username, avatar: u?.avatar, avatar_image: u?.avatar_image || null };
    });
}

export async function removeJoinRequest(clubId, userId) {
  if (hasDatabase) {
    await pool.query("DELETE FROM club_join_requests WHERE club_id=$1 AND user_id=$2", [clubId, userId]);
    return;
  }
  mem.joinRequests = mem.joinRequests.filter((r) => !(r.club_id === clubId && r.user_id === userId));
}

export async function createUser(username, passwordHash, avatar) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash, avatar) VALUES ($1,$2,$3) RETURNING id, username, avatar",
      [username, passwordHash, avatar]
    );
    return rows[0];
  }
  if (mem.users.find((u) => u.username.toLowerCase() === username.toLowerCase())) return null;
  const user = { id: mem.nextUserId++, username, password_hash: passwordHash, avatar };
  mem.users.push(user);
  return { id: user.id, username: user.username, avatar: user.avatar };
}

export async function findUserByUsername(username) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
    return rows[0] || null;
  }
  return mem.users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

export async function findUserById(id) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT id, username, avatar, avatar_image FROM users WHERE id = $1", [id]);
    return rows[0] || null;
  }
  const u = mem.users.find((u) => u.id === id);
  return u ? { id: u.id, username: u.username, avatar: u.avatar, avatar_image: u.avatar_image || null } : null;
}

export async function createClub({ code, name, ownerId, smallBlind, bigBlind, buyIn, rakePercent }) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO clubs (code, name, owner_id, small_blind, big_blind, buy_in, rake_percent, treasury_chips)
       VALUES ($1,$2,$3,$4,$5,$6,$7,10000) RETURNING *`,
      [code, name, ownerId, smallBlind, bigBlind, buyIn, rakePercent]
    );
    return rows[0];
  }
  const club = { id: mem.nextClubId++, code, name, owner_id: ownerId, small_blind: smallBlind, big_blind: bigBlind, buy_in: buyIn, rake_percent: rakePercent, treasury_chips: 10000, level: 0, level_expires_at: null, rk_balance: 0 };
  mem.clubs.push(club);
  return club;
}

export async function getClubByCode(code) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM clubs WHERE code = $1", [code]);
    return rows[0] || null;
  }
  return mem.clubs.find((c) => c.code === code) || null;
}

export async function getClubById(id) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM clubs WHERE id = $1", [id]);
    return rows[0] || null;
  }
  return mem.clubs.find((c) => c.id === Number(id)) || null;
}

export async function addMember(clubId, userId, chips, role) {
  if (hasDatabase) {
    await pool.query(
      `INSERT INTO club_members (club_id, user_id, chips, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (club_id, user_id) DO NOTHING`,
      [clubId, userId, chips, role]
    );
    return;
  }
  if (!mem.members.find((m) => m.club_id === clubId && m.user_id === userId)) {
    mem.members.push({ club_id: clubId, user_id: userId, chips, role });
  }
}

export async function getMember(clubId, userId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM club_members WHERE club_id=$1 AND user_id=$2", [clubId, userId]);
    return rows[0] || null;
  }
  return mem.members.find((m) => m.club_id === clubId && m.user_id === userId) || null;
}

export async function listMembers(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.avatar, u.avatar_image, u.last_seen, m.chips, m.role, m.nickname, m.note, m.joined_at
       FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.club_id = $1 ORDER BY m.joined_at ASC`,
      [clubId]
    );
    return rows;
  }
  return mem.members
    .filter((m) => m.club_id === clubId)
    .map((m) => {
      const u = mem.users.find((u) => u.id === m.user_id);
      return { id: u.id, username: u.username, avatar: u.avatar, avatar_image: u.avatar_image || null, last_seen: u.last_seen || null, chips: m.chips, role: m.role, nickname: m.nickname || null, note: m.note || null, joined_at: m.joined_at };
    });
}

export async function setMemberNickname(clubId, userId, nickname) {
  if (hasDatabase) {
    await pool.query("UPDATE club_members SET nickname=$3 WHERE club_id=$1 AND user_id=$2", [clubId, userId, nickname || null]);
    return;
  }
  const m = mem.members.find((m) => m.club_id === clubId && m.user_id === userId);
  if (m) m.nickname = nickname || null;
}

export async function setMemberNote(clubId, userId, note) {
  if (hasDatabase) {
    await pool.query("UPDATE club_members SET note=$3 WHERE club_id=$1 AND user_id=$2", [clubId, userId, note || null]);
    return;
  }
  const m = mem.members.find((m) => m.club_id === clubId && m.user_id === userId);
  if (m) m.note = note || null;
}

export async function touchLastSeen(userId) {
  if (hasDatabase) {
    await pool.query("UPDATE users SET last_seen = now() WHERE id = $1", [userId]);
    return;
  }
  const u = mem.users.find((u) => u.id === userId);
  if (u) u.last_seen = new Date();
}

// Carreira de UM membro específico dentro do clube — usado no painel de
// gerenciamento de membros (mãos jogadas e ganhos totais, tudo em fichas
// daquele clube). Mesma fonte de dados da aba Carreira do próprio jogador.
export async function getMemberCareerEntries(clubId, userId, limit = 20000) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "SELECT delta, table_id, created_at FROM hand_ledger WHERE club_id=$1 AND user_id=$2 ORDER BY created_at ASC LIMIT $3",
      [clubId, userId, limit]
    );
    return rows.map((r) => ({ delta: Number(r.delta), tableId: r.table_id, createdAt: r.created_at }));
  }
  return mem.handLedger
    .filter((h) => h.club_id === clubId && h.user_id === userId)
    .slice(0, limit)
    .map((h) => ({ delta: h.delta, tableId: h.table_id, createdAt: h.created_at }));
}

// Clubes dos quais o usuário já faz parte — usado no Lobby pra listar
// "seus clubes" (dono ou membro), sem precisar do código de novo.
export async function listClubsForUser(userId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.name, c.image, c.cover_image, c.owner_id, c.level, c.level_expires_at, m.chips, m.role
       FROM club_members m JOIN clubs c ON c.id = m.club_id
       WHERE m.user_id = $1 ORDER BY m.joined_at ASC`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, image: r.image || null, coverImage: r.cover_image || null, chips: r.chips, isOwner: r.owner_id === userId,
      level: (r.level_expires_at && new Date(r.level_expires_at).getTime() > Date.now()) ? Number(r.level || 0) : 0,
    }));
  }
  return mem.members
    .filter((m) => m.user_id === userId)
    .map((m) => {
      const c = mem.clubs.find((c) => c.id === m.club_id);
      const levelStillValid = c.level_expires_at && new Date(c.level_expires_at).getTime() > Date.now();
      return {
        id: c.id, code: c.code, name: c.name, image: c.image || null, coverImage: c.cover_image || null, chips: m.chips, isOwner: c.owner_id === userId,
        level: levelStillValid ? Number(c.level || 0) : 0,
      };
    });
}

export async function adjustMemberChips(clubId, userId, delta) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "UPDATE club_members SET chips = GREATEST(chips + $3, 0) WHERE club_id=$1 AND user_id=$2 RETURNING chips",
      [clubId, userId, delta]
    );
    return rows[0]?.chips ?? 0;
  }
  const m = mem.members.find((m) => m.club_id === clubId && m.user_id === userId);
  if (!m) return 0;
  m.chips = Math.max(0, m.chips + delta);
  return m.chips;
}

// Saldo do CLUBE (tesouraria) — separado do saldo de cada jogador. É de onde
// saem as fichas que o dono distribui, e pra onde voltam quando ele retira.
export async function adjustClubTreasury(clubId, delta) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "UPDATE clubs SET treasury_chips = GREATEST(treasury_chips + $2, 0) WHERE id=$1 RETURNING treasury_chips",
      [clubId, delta]
    );
    return rows[0]?.treasury_chips ?? 0;
  }
  const c = mem.clubs.find((c) => c.id === clubId);
  if (!c) return 0;
  if (c.treasury_chips === undefined) c.treasury_chips = 1000;
  c.treasury_chips = Math.max(0, c.treasury_chips + delta);
  return c.treasury_chips;
}

// Mesma ideia, mas pro saldo de RK (rake coletado) — fica SEPARADO do
// treasury_chips de propósito, pra nunca se confundir com ficha normal
// do clube no dia do acerto.
export async function adjustClubRkBalance(clubId, delta) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "UPDATE clubs SET rk_balance = GREATEST(rk_balance + $2, 0) WHERE id=$1 RETURNING rk_balance",
      [clubId, delta]
    );
    return rows[0]?.rk_balance ?? 0;
  }
  const c = mem.clubs.find((c) => c.id === clubId);
  if (!c) return 0;
  if (c.rk_balance === undefined) c.rk_balance = 0;
  c.rk_balance = Math.max(0, c.rk_balance + delta);
  return c.rk_balance;
}

export async function recordRake(clubId, amount, platformAmount = 0) {
  if (amount <= 0 && platformAmount <= 0) return;
  if (hasDatabase) {
    await pool.query("INSERT INTO rake_ledger (club_id, amount, platform_amount) VALUES ($1,$2,$3)", [clubId, amount, platformAmount]);
    return;
  }
  mem.rake.push({ club_id: clubId, amount, platform_amount: platformAmount, created_at: new Date() });
}

export async function getWeeklyRake(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM rake_ledger WHERE club_id=$1 AND created_at > now() - interval '7 days'",
      [clubId]
    );
    return Number(rows[0].total);
  }
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return mem.rake.filter((r) => r.club_id === clubId && r.created_at.getTime() > since).reduce((s, r) => s + r.amount, 0);
}

// Rake acumulado total do clube (todo o histórico, não só os últimos 7 dias)
// — é o número que fica visível pro dono no painel administrativo.
export async function getTotalRake(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM rake_ledger WHERE club_id=$1", [clubId]);
    return Number(rows[0].total);
  }
  return mem.rake.filter((r) => r.club_id === clubId).reduce((s, r) => s + r.amount, 0);
}

// Rake do APP (a fatia fixa, ex 1%, que nunca é do clube) acumulado nesse
// clube — separado do rake do clube pra não misturar as duas contas.
export async function getTotalPlatformRake(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT COALESCE(SUM(platform_amount),0) AS total FROM rake_ledger WHERE club_id=$1", [clubId]);
    return Number(rows[0].total);
  }
  return mem.rake.filter((r) => r.club_id === clubId).reduce((s, r) => s + (r.platform_amount || 0), 0);
}

// ---------------------------------------------------------------------
// AVISOS (announcements) — publicados pelo dono do app, visíveis pra
// todo mundo. Um pop-up mostra sempre o mais recente (no máximo 1x por
// dia por usuário, controlado no cliente); a lista mostra o histórico.
// ---------------------------------------------------------------------
export async function createAnnouncement({ version, title, body }) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "INSERT INTO announcements (version, title, body) VALUES ($1,$2,$3) RETURNING id, version, title, body, created_at",
      [version || null, title, body]
    );
    return rows[0];
  }
  const a = { id: mem.nextAnnouncementId++, version: version || null, title, body, created_at: new Date() };
  mem.announcements.push(a);
  return a;
}

export async function getLatestAnnouncement() {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT id, version, title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT 1");
    return rows[0] || null;
  }
  return mem.announcements[mem.announcements.length - 1] || null;
}

export async function listAnnouncements(limit = 30) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT id, version, title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows;
  }
  return [...mem.announcements].reverse().slice(0, limit);
}

// ---------------------------------------------------------------------
// NOTIFICAÇÕES pessoais — geradas automaticamente pelo servidor (ex:
// recebeu fichas de um admin/dono de clube, entrou num clube).
// ---------------------------------------------------------------------
export async function createNotification(userId, clubId, title, body) {
  if (hasDatabase) {
    await pool.query("INSERT INTO notifications (user_id, club_id, title, body) VALUES ($1,$2,$3,$4)", [userId, clubId || null, title, body]);
    return;
  }
  mem.notifications.push({ id: mem.nextNotificationId++, user_id: userId, club_id: clubId || null, title, body, created_at: new Date() });
}

export async function listNotifications(userId, limit = 60) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT n.id, n.club_id, c.name AS club_name, n.title, n.body, n.created_at
       FROM notifications n LEFT JOIN clubs c ON c.id = n.club_id
       WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }
  return mem.notifications
    .filter((n) => n.user_id === userId)
    .slice().reverse().slice(0, limit)
    .map((n) => ({ ...n, club_name: n.club_id ? mem.clubs.find((c) => c.id === n.club_id)?.name : null }));
}

export async function deleteNotification(id, userId) {
  if (hasDatabase) {
    await pool.query("DELETE FROM notifications WHERE id=$1 AND user_id=$2", [id, userId]);
    return;
  }
  mem.notifications = mem.notifications.filter((n) => !(n.id === id && n.user_id === userId));
}

export async function deleteAllNotifications(userId) {
  if (hasDatabase) {
    await pool.query("DELETE FROM notifications WHERE user_id=$1", [userId]);
    return;
  }
  mem.notifications = mem.notifications.filter((n) => n.user_id !== userId);
}

// ---------------------------------------------------------------------
// CARREIRA — resultado de cada mão jogada em mesa de CLUBE (não inclui
// fichas fictícias de "Jogar" fora de clube, de propósito). Retorna a
// lista crua; dia/mês/ano e o gráfico são todos calculados no cliente
// a partir dela.
// ---------------------------------------------------------------------
export async function recordHandLedger(clubId, tableId, userId, delta) {
  if (delta === 0) return;
  if (hasDatabase) {
    await pool.query("INSERT INTO hand_ledger (club_id, table_id, user_id, delta) VALUES ($1,$2,$3,$4)", [clubId, tableId || null, userId, delta]);
    return;
  }
  mem.handLedger.push({ id: mem.nextHandLedgerId++, club_id: clubId, table_id: tableId || null, user_id: userId, delta, created_at: new Date() });
}

export async function getCareerEntries(userId, limit = 20000) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      "SELECT delta, table_id, created_at FROM hand_ledger WHERE user_id=$1 ORDER BY created_at ASC LIMIT $2",
      [userId, limit]
    );
    return rows.map((r) => ({ delta: Number(r.delta), tableId: r.table_id, createdAt: r.created_at }));
  }
  return mem.handLedger
    .filter((h) => h.user_id === userId)
    .slice(0, limit)
    .map((h) => ({ delta: h.delta, tableId: h.table_id, createdAt: h.created_at }));
}

// ============================================================
// SISTEMA DE RAKE / RAKEBACK / AGENTE (comissão) / FECHAMENTO
// ============================================================
// "Agente" aqui é um conceito separado do "role='agent'" (Gestor) que já
// existia no clube — Gestor tem poder administrativo total (igual ao
// dono); Agente só ganha comissão sobre o rake da carteira de membros
// vinculados a ele, sem nenhum poder de administrar o clube. As duas
// coisas são independentes.

export async function createAgentWallet(clubId, userId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO agent_wallets (club_id, user_id) VALUES ($1,$2)
       ON CONFLICT (club_id, user_id) DO UPDATE SET status = 'active' RETURNING *`,
      [clubId, userId]
    );
    return rows[0];
  }
  let w = mem.agentWallets.find((w) => w.club_id === clubId && w.user_id === userId);
  if (w) { w.status = "active"; return w; }
  w = { id: mem.nextAgentWalletId++, club_id: clubId, user_id: userId, status: "active", created_at: new Date().toISOString() };
  mem.agentWallets.push(w);
  return w;
}

export async function getAgentWallet(clubId, userId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM agent_wallets WHERE club_id=$1 AND user_id=$2", [clubId, userId]);
    return rows[0] || null;
  }
  return mem.agentWallets.find((w) => w.club_id === clubId && w.user_id === userId) || null;
}

export async function getAgentWalletById(id) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM agent_wallets WHERE id=$1", [id]);
    return rows[0] || null;
  }
  return mem.agentWallets.find((w) => w.id === Number(id)) || null;
}

export async function listAgentWallets(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT aw.*, u.username FROM agent_wallets aw JOIN users u ON u.id = aw.user_id WHERE aw.club_id = $1 ORDER BY aw.created_at ASC`,
      [clubId]
    );
    return rows;
  }
  return mem.agentWallets
    .filter((w) => w.club_id === clubId)
    .map((w) => ({ ...w, username: mem.users.find((u) => u.id === w.user_id)?.username }));
}

export async function setAgentStatus(agentWalletId, status) {
  if (hasDatabase) {
    await pool.query("UPDATE agent_wallets SET status=$1 WHERE id=$2", [status, agentWalletId]);
    return;
  }
  const w = mem.agentWallets.find((w) => w.id === Number(agentWalletId));
  if (w) w.status = status;
}

// --- % de comissão do agente (com histórico — nunca sobrescreve) ---
export async function setCommissionRate(agentWalletId, ratePercent, setBy) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO commission_rate_history (agent_wallet_id, rate_percent, set_by) VALUES ($1,$2,$3) RETURNING *`,
      [agentWalletId, ratePercent, setBy]
    );
    return rows[0];
  }
  const row = { id: mem.nextCommissionRateId++, agent_wallet_id: Number(agentWalletId), rate_percent: ratePercent, effective_from: new Date().toISOString(), set_by: setBy, created_at: new Date().toISOString() };
  mem.commissionRateHistory.push(row);
  return row;
}

export async function getCurrentCommissionRate(agentWalletId, atTime = new Date()) {
  const t = new Date(atTime).getTime();
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT * FROM commission_rate_history WHERE agent_wallet_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC, id DESC LIMIT 1`,
      [agentWalletId, new Date(atTime).toISOString()]
    );
    return rows[0] ? Number(rows[0].rate_percent) : 0;
  }
  // Desempate por "id" (sempre crescente) quando duas mudanças caem no
  // mesmo milissegundo — sem isso, um sort por timestamp empatado podia
  // devolver a taxa ANTIGA em vez da mais recente de verdade.
  const rows = mem.commissionRateHistory
    .filter((r) => r.agent_wallet_id === Number(agentWalletId) && new Date(r.effective_from).getTime() <= t)
    .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from) || b.id - a.id);
  return rows[0] ? Number(rows[0].rate_percent) : 0;
}

export async function listCommissionRateHistory(agentWalletId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM commission_rate_history WHERE agent_wallet_id=$1 ORDER BY effective_from DESC", [agentWalletId]);
    return rows;
  }
  return mem.commissionRateHistory.filter((r) => r.agent_wallet_id === Number(agentWalletId)).sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from));
}

// --- % de rakeback do membro (com histórico) ---
export async function setRakebackRate(clubId, memberUserId, ratePercent, setBy) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO rakeback_rate_history (club_id, member_user_id, rate_percent, set_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [clubId, memberUserId, ratePercent, setBy]
    );
    return rows[0];
  }
  const row = { id: mem.nextRakebackRateId++, club_id: clubId, member_user_id: memberUserId, rate_percent: ratePercent, effective_from: new Date().toISOString(), set_by: setBy, created_at: new Date().toISOString() };
  mem.rakebackRateHistory.push(row);
  return row;
}

export async function getCurrentRakebackRate(clubId, memberUserId, atTime = new Date()) {
  const t = new Date(atTime).getTime();
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT * FROM rakeback_rate_history WHERE club_id=$1 AND member_user_id=$2 AND effective_from <= $3 ORDER BY effective_from DESC, id DESC LIMIT 1`,
      [clubId, memberUserId, new Date(atTime).toISOString()]
    );
    return rows[0] ? Number(rows[0].rate_percent) : 0;
  }
  const rows = mem.rakebackRateHistory
    .filter((r) => r.club_id === clubId && r.member_user_id === memberUserId && new Date(r.effective_from).getTime() <= t)
    .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from) || b.id - a.id);
  return rows[0] ? Number(rows[0].rate_percent) : 0;
}

export async function listRakebackRateHistory(clubId, memberUserId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM rakeback_rate_history WHERE club_id=$1 AND member_user_id=$2 ORDER BY effective_from DESC", [clubId, memberUserId]);
    return rows;
  }
  return mem.rakebackRateHistory.filter((r) => r.club_id === clubId && r.member_user_id === memberUserId).sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from));
}

// --- vínculo membro -> agente (com histórico completo) ---
export async function linkMemberToAgent(clubId, memberUserId, agentWalletId, changedBy) {
  const now = new Date().toISOString();
  if (hasDatabase) {
    await pool.query(
      `UPDATE agent_member_links SET linked_until=$1 WHERE club_id=$2 AND member_user_id=$3 AND linked_until IS NULL`,
      [now, clubId, memberUserId]
    );
    const { rows } = await pool.query(
      `INSERT INTO agent_member_links (club_id, member_user_id, agent_wallet_id, changed_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [clubId, memberUserId, agentWalletId, changedBy]
    );
    return rows[0];
  }
  mem.agentMemberLinks.forEach((l) => { if (l.club_id === clubId && l.member_user_id === memberUserId && !l.linked_until) l.linked_until = now; });
  const row = { id: mem.nextAgentMemberLinkId++, club_id: clubId, member_user_id: memberUserId, agent_wallet_id: agentWalletId, linked_from: now, linked_until: null, changed_by: changedBy, created_at: now };
  mem.agentMemberLinks.push(row);
  return row;
}

export async function getCurrentAgentLink(clubId, memberUserId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT * FROM agent_member_links WHERE club_id=$1 AND member_user_id=$2 AND linked_until IS NULL ORDER BY linked_from DESC LIMIT 1`,
      [clubId, memberUserId]
    );
    return rows[0] || null;
  }
  return mem.agentMemberLinks
    .filter((l) => l.club_id === clubId && l.member_user_id === memberUserId && !l.linked_until)
    .sort((a, b) => new Date(b.linked_from) - new Date(a.linked_from))[0] || null;
}

export async function listAgentLinkHistory(clubId, memberUserId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM agent_member_links WHERE club_id=$1 AND member_user_id=$2 ORDER BY linked_from DESC", [clubId, memberUserId]);
    return rows;
  }
  return mem.agentMemberLinks.filter((l) => l.club_id === clubId && l.member_user_id === memberUserId).sort((a, b) => new Date(b.linked_from) - new Date(a.linked_from));
}

// Todos os membros vinculados atualmente a um agente (pra "carteira").
export async function listAgentMembers(clubId, agentWalletId) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT l.*, u.username FROM agent_member_links l JOIN users u ON u.id = l.member_user_id
       WHERE l.club_id=$1 AND l.agent_wallet_id=$2 AND l.linked_until IS NULL`,
      [clubId, agentWalletId]
    );
    return rows;
  }
  return mem.agentMemberLinks
    .filter((l) => l.club_id === clubId && l.agent_wallet_id === Number(agentWalletId) && !l.linked_until)
    .map((l) => ({ ...l, username: mem.users.find((u) => u.id === l.member_user_id)?.username }));
}

// ------------------------------------------------------------
// O EVENTO — coração do sistema. Roda a REGRA DE OURO exatamente como
// especificada: rake bruto -> rakeback do membro -> base líquida ->
// comissão do agente sobre a base líquida -> resultado do clube. Tudo
// calculado e GRAVADO usando as taxas que estavam valendo NESTE INSTANTE
// (por isso lê getCurrentRakebackRate/getCurrentCommissionRate antes de
// gravar) — assim, mudar a % depois nunca recalcula o passado.
// ------------------------------------------------------------
export async function recordRakeEvent(clubId, memberUserId, tableCode, grossAmount) {
  if (!grossAmount || grossAmount <= 0) return null;
  const rakebackRate = await getCurrentRakebackRate(clubId, memberUserId);
  const rakebackAmount = Math.floor((grossAmount * rakebackRate) / 100);
  const netAmount = grossAmount - rakebackAmount;

  const link = await getCurrentAgentLink(clubId, memberUserId);
  let agentWalletId = null, commissionRate = 0, commissionAmount = 0;
  if (link?.agent_wallet_id) {
    const agent = await getAgentWalletById(link.agent_wallet_id);
    if (agent && agent.status === "active") {
      agentWalletId = agent.id;
      commissionRate = await getCurrentCommissionRate(agent.id);
      commissionAmount = Math.floor((netAmount * commissionRate) / 100);
    }
  }
  const clubResult = netAmount - commissionAmount;

  // O rake bruto entra direto na TESOURARIA do clube (mesma ficha de
  // sempre — pedido explícito: facilita o fechamento semanal, sem
  // precisar converter entre dois tipos de ficha). Rakeback e comissão
  // saem dessa mesma tesouraria e viram ficha DE VERDADE na hora pro
  // jogador/agente (pago imediatamente, não só anotado pra pagar depois).
  await adjustClubTreasury(clubId, grossAmount);
  if (rakebackAmount > 0) {
    await adjustMemberChips(clubId, memberUserId, rakebackAmount);
    await adjustClubTreasury(clubId, -rakebackAmount);
  }
  if (commissionAmount > 0 && agentWalletId) {
    const agentRow = await getAgentWalletById(agentWalletId);
    if (agentRow) {
      await adjustMemberChips(clubId, agentRow.user_id, commissionAmount);
      await adjustClubTreasury(clubId, -commissionAmount);
    }
  }

  const row = {
    club_id: clubId, member_user_id: memberUserId, table_code: tableCode || null,
    gross_amount: grossAmount, rakeback_rate: rakebackRate, rakeback_amount: rakebackAmount,
    net_amount: netAmount, agent_wallet_id: agentWalletId, commission_rate: commissionRate,
    commission_amount: commissionAmount, club_result: clubResult,
  };
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO rake_events (club_id, member_user_id, table_code, gross_amount, rakeback_rate, rakeback_amount, net_amount, agent_wallet_id, commission_rate, commission_amount, club_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [clubId, memberUserId, tableCode || null, grossAmount, rakebackRate, rakebackAmount, netAmount, agentWalletId, commissionRate, commissionAmount, clubResult]
    );
    return rows[0];
  }
  const full = { id: mem.nextRakeEventId++, ...row, closing_id: null, created_at: new Date().toISOString() };
  mem.rakeEvents.push(full);
  return full;
}

function inRange(createdAt, from, to) {
  const t = new Date(createdAt).getTime();
  return t >= new Date(from).getTime() && t <= new Date(to).getTime();
}

export async function getRakeSummary(clubId, from, to) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(gross_amount),0) AS gross, COALESCE(SUM(rakeback_amount),0) AS rakeback,
              COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(commission_amount),0) AS commission,
              COALESCE(SUM(club_result),0) AS club_result
       FROM rake_events WHERE club_id=$1 AND created_at BETWEEN $2 AND $3`,
      [clubId, from, to]
    );
    const r = rows[0];
    return { gross: Number(r.gross), rakeback: Number(r.rakeback), net: Number(r.net), commission: Number(r.commission), clubResult: Number(r.club_result) };
  }
  const evs = mem.rakeEvents.filter((e) => e.club_id === clubId && inRange(e.created_at, from, to));
  return {
    gross: evs.reduce((s, e) => s + e.gross_amount, 0),
    rakeback: evs.reduce((s, e) => s + e.rakeback_amount, 0),
    net: evs.reduce((s, e) => s + e.net_amount, 0),
    commission: evs.reduce((s, e) => s + e.commission_amount, 0),
    clubResult: evs.reduce((s, e) => s + e.club_result, 0),
  };
}

export async function getAgentRakeTable(clubId, from, to) {
  const agents = await listAgentWallets(clubId);
  const out = [];
  for (const a of agents) {
    let evs;
    if (hasDatabase) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(gross_amount),0) AS gross, COALESCE(SUM(rakeback_amount),0) AS rakeback,
                COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(commission_amount),0) AS commission, COUNT(DISTINCT member_user_id) AS members
         FROM rake_events WHERE club_id=$1 AND agent_wallet_id=$2 AND created_at BETWEEN $3 AND $4`,
        [clubId, a.id, from, to]
      );
      evs = rows[0];
    } else {
      const filtered = mem.rakeEvents.filter((e) => e.club_id === clubId && e.agent_wallet_id === a.id && inRange(e.created_at, from, to));
      evs = {
        gross: filtered.reduce((s, e) => s + e.gross_amount, 0),
        rakeback: filtered.reduce((s, e) => s + e.rakeback_amount, 0),
        net: filtered.reduce((s, e) => s + e.net_amount, 0),
        commission: filtered.reduce((s, e) => s + e.commission_amount, 0),
        members: new Set(filtered.map((e) => e.member_user_id)).size,
      };
    }
    const rate = await getCurrentCommissionRate(a.id);
    const rakebackRate = await getCurrentRakebackRate(clubId, a.user_id);
    const memberCount = (await listAgentMembers(clubId, a.id)).length;
    out.push({
      id: a.id, username: a.username, status: a.status, commissionRate: rate, rakebackRate, memberCount,
      grossRake: Number(evs.gross), rakeback: Number(evs.rakeback), netBase: Number(evs.net), commission: Number(evs.commission),
    });
  }
  return out;
}

export async function getMemberRakeTable(clubId, from, to) {
  const members = await listMembers(clubId);
  const out = [];
  for (const m of members) {
    let evs;
    if (hasDatabase) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(gross_amount),0) AS gross, COALESCE(SUM(rakeback_amount),0) AS rakeback, COALESCE(SUM(net_amount),0) AS net
         FROM rake_events WHERE club_id=$1 AND member_user_id=$2 AND created_at BETWEEN $3 AND $4`,
        [clubId, m.id, from, to]
      );
      evs = rows[0];
    } else {
      const filtered = mem.rakeEvents.filter((e) => e.club_id === clubId && e.member_user_id === m.id && inRange(e.created_at, from, to));
      evs = {
        gross: filtered.reduce((s, e) => s + e.gross_amount, 0),
        rakeback: filtered.reduce((s, e) => s + e.rakeback_amount, 0),
        net: filtered.reduce((s, e) => s + e.net_amount, 0),
      };
    }
    if (Number(evs.gross) === 0) continue; // não polui a lista com quem nunca gerou rake
    const link = await getCurrentAgentLink(clubId, m.id);
    const agent = link?.agent_wallet_id ? await getAgentWalletById(link.agent_wallet_id) : null;
    const rate = await getCurrentRakebackRate(clubId, m.id);
    out.push({
      id: m.id, username: m.username, agentUsername: agent?.user_id ? mem.users?.find?.((u) => u.id === agent.user_id)?.username : null,
      agentId: agent?.id || null, rakebackRate: rate,
      grossRake: Number(evs.gross), rakeback: Number(evs.rakeback), netRake: Number(evs.net),
    });
  }
  return out;
}

export async function closeRakePeriod(clubId, type, periodStart, periodEnd, closedBy) {
  let events;
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT * FROM rake_events WHERE club_id=$1 AND closing_id IS NULL AND created_at BETWEEN $2 AND $3`,
      [clubId, periodStart, periodEnd]
    );
    events = rows;
  } else {
    events = mem.rakeEvents.filter((e) => e.club_id === clubId && !e.closing_id && inRange(e.created_at, periodStart, periodEnd));
  }
  const grossRake = events.reduce((s, e) => s + Number(e.gross_amount), 0);
  const rakebackTotal = events.reduce((s, e) => s + Number(e.rakeback_amount), 0);
  const commissionTotal = events.reduce((s, e) => s + Number(e.commission_amount), 0);
  const clubResult = events.reduce((s, e) => s + Number(e.club_result), 0);

  let closing;
  if (hasDatabase) {
    const { rows } = await pool.query(
      `INSERT INTO rake_closings (club_id, type, period_start, period_end, closed_by, gross_rake, rakeback_total, commission_total, club_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [clubId, type, periodStart, periodEnd, closedBy, grossRake, rakebackTotal, commissionTotal, clubResult]
    );
    closing = rows[0];
    if (events.length) await pool.query(`UPDATE rake_events SET closing_id=$1 WHERE id = ANY($2::int[])`, [closing.id, events.map((e) => e.id)]);
  } else {
    closing = {
      id: mem.nextRakeClosingId++, club_id: clubId, type, period_start: periodStart, period_end: periodEnd,
      closed_at: new Date().toISOString(), closed_by: closedBy, gross_rake: grossRake, rakeback_total: rakebackTotal,
      commission_total: commissionTotal, club_result: clubResult, status: "closed",
    };
    mem.rakeClosings.push(closing);
    events.forEach((e) => { e.closing_id = closing.id; });
  }
  return { closing, eventCount: events.length };
}

export async function listRakeClosings(clubId) {
  if (hasDatabase) {
    const { rows } = await pool.query("SELECT * FROM rake_closings WHERE club_id=$1 ORDER BY closed_at DESC", [clubId]);
    return rows;
  }
  return mem.rakeClosings.filter((c) => c.club_id === clubId).sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
}

export async function getRakeClosingDetail(closingId) {
  let closing, events;
  if (hasDatabase) {
    const c = await pool.query("SELECT * FROM rake_closings WHERE id=$1", [closingId]);
    closing = c.rows[0];
    const e = await pool.query(
      `SELECT re.*, u.username FROM rake_events re JOIN users u ON u.id = re.member_user_id WHERE re.closing_id=$1`,
      [closingId]
    );
    events = e.rows;
  } else {
    closing = mem.rakeClosings.find((c) => c.id === Number(closingId));
    events = mem.rakeEvents.filter((e) => e.closing_id === Number(closingId)).map((e) => ({ ...e, username: mem.users.find((u) => u.id === e.member_user_id)?.username }));
  }
  return { closing, events };
}

export async function getAgentWalletSummary(clubId, agentWalletId, from, to) {
  if (hasDatabase) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(gross_amount),0) AS gross, COALESCE(SUM(rakeback_amount),0) AS rakeback,
              COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(commission_amount),0) AS commission,
              COALESCE(SUM(CASE WHEN closing_id IS NULL THEN commission_amount ELSE 0 END),0) AS pending,
              COALESCE(SUM(CASE WHEN closing_id IS NOT NULL THEN commission_amount ELSE 0 END),0) AS paid
       FROM rake_events WHERE club_id=$1 AND agent_wallet_id=$2 AND created_at BETWEEN $3 AND $4`,
      [clubId, agentWalletId, from, to]
    );
    const r = rows[0];
    return { gross: Number(r.gross), rakeback: Number(r.rakeback), net: Number(r.net), commission: Number(r.commission), pending: Number(r.pending), paid: Number(r.paid) };
  }
  const filtered = mem.rakeEvents.filter((e) => e.club_id === clubId && e.agent_wallet_id === Number(agentWalletId) && inRange(e.created_at, from, to));
  return {
    gross: filtered.reduce((s, e) => s + e.gross_amount, 0),
    rakeback: filtered.reduce((s, e) => s + e.rakeback_amount, 0),
    net: filtered.reduce((s, e) => s + e.net_amount, 0),
    commission: filtered.reduce((s, e) => s + e.commission_amount, 0),
    pending: filtered.filter((e) => !e.closing_id).reduce((s, e) => s + e.commission_amount, 0),
    paid: filtered.filter((e) => e.closing_id).reduce((s, e) => s + e.commission_amount, 0),
  };
}
