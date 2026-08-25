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
  nextUserId: 1,
  nextClubId: 1,
};

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
      `INSERT INTO clubs (code, name, owner_id, small_blind, big_blind, buy_in, rake_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code, name, ownerId, smallBlind, bigBlind, buyIn, rakePercent]
    );
    return rows[0];
  }
  const club = { id: mem.nextClubId++, code, name, owner_id: ownerId, small_blind: smallBlind, big_blind: bigBlind, buy_in: buyIn, rake_percent: rakePercent };
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
      `SELECT u.id, u.username, u.avatar, m.chips, m.role
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
      return { id: u.id, username: u.username, avatar: u.avatar, chips: m.chips, role: m.role };
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

export async function recordRake(clubId, amount) {
  if (amount <= 0) return;
  if (hasDatabase) {
    await pool.query("INSERT INTO rake_ledger (club_id, amount) VALUES ($1,$2)", [clubId, amount]);
    return;
  }
  mem.rake.push({ club_id: clubId, amount, created_at: new Date() });
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
