import { pool, hasDatabase } from "./db.js";

// ---------------------------------------------------------------------
// Thin data-access layer. When DATABASE_URL isn't set (e.g. quick local
// testing without Postgres installed), we transparently fall back to an
// in-memory version of the same functions so the rest of the server
// doesn't need to know which backend it's talking to.
// ---------------------------------------------------------------------

export const AVATAR_OPTIONS = Array.from({ length: 16 }, (_, i) => `avatar_${String(i + 1).padStart(2, "0")}`);

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
  nextUserId: 1,
  nextClubId: 1,
  nextClubTableId: 1,
  nextLedgerId: 1,
  nextJoinRequestId: 1,
  nextAnnouncementId: 1,
  nextNotificationId: 1,
  nextHandLedgerId: 1,
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
    await pool.query("UPDATE users SET avatar = $1 WHERE id = $2", [avatar, userId]);
    return;
  }
  const u = mem.users.find((u) => u.id === userId);
  if (u) u.avatar = avatar;
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
      `SELECT r.id, r.user_id, u.username, u.avatar, r.created_at
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
      return { id: r.id, user_id: r.user_id, username: u?.username, avatar: u?.avatar };
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
    const { rows } = await pool.query("SELECT id, username, avatar FROM users WHERE id = $1", [id]);
    return rows[0] || null;
  }
  const u = mem.users.find((u) => u.id === id);
  return u ? { id: u.id, username: u.username, avatar: u.avatar } : null;
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
  const club = { id: mem.nextClubId++, code, name, owner_id: ownerId, small_blind: smallBlind, big_blind: bigBlind, buy_in: buyIn, rake_percent: rakePercent, treasury_chips: 10000 };
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
      `SELECT u.id, u.username, u.avatar, u.last_seen, m.chips, m.role, m.nickname, m.note, m.joined_at
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
      return { id: u.id, username: u.username, avatar: u.avatar, last_seen: u.last_seen || null, chips: m.chips, role: m.role, nickname: m.nickname || null, note: m.note || null, joined_at: m.joined_at };
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
      `SELECT c.id, c.code, c.name, c.owner_id, m.chips, m.role
       FROM club_members m JOIN clubs c ON c.id = m.club_id
       WHERE m.user_id = $1 ORDER BY m.joined_at ASC`,
      [userId]
    );
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, chips: r.chips, isOwner: r.owner_id === userId }));
  }
  return mem.members
    .filter((m) => m.user_id === userId)
    .map((m) => {
      const c = mem.clubs.find((c) => c.id === m.club_id);
      return { id: c.id, code: c.code, name: c.name, chips: m.chips, isOwner: c.owner_id === userId };
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
