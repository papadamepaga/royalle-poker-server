import pg from "pg";

const { Pool } = pg;

// Render's Postgres add-on injects DATABASE_URL automatically once the
// database is linked to this web service. Locally, set it in a .env or
// export it before running `npm start` if you want to test against a
// real database; otherwise the server falls back to an in-memory store
// (see memoryStore.js) so local development still works without Postgres.
const connectionString = process.env.DATABASE_URL;

export const hasDatabase = Boolean(connectionString);

export const pool = hasDatabase
  ? new Pool({ connectionString, ssl: connectionString.includes("render.com") ? { rejectUnauthorized: false } : false })
  : null;

export async function migrate() {
  if (!hasDatabase) {
    console.log("Sem DATABASE_URL configurada — rodando com armazenamento em memória (dados não persistem).");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT 'avatar_01',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      small_blind INTEGER NOT NULL DEFAULT 25,
      big_blind INTEGER NOT NULL DEFAULT 50,
      buy_in INTEGER NOT NULL DEFAULT 5000,
      rake_percent NUMERIC NOT NULL DEFAULT 5,
      treasury_chips BIGINT NOT NULL DEFAULT 1000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS treasury_chips BIGINT NOT NULL DEFAULT 1000;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_members (
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      chips BIGINT NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (club_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rake_ledger (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      amount NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Carteira avulsa para as mesas públicas de "Jogar" (fora de clube),
  // separada do saldo de fichas de cada clube. Essa é a "Royalle Coin".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quick_wallets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      chips BIGINT NOT NULL DEFAULT 10000,
      last_daily_claim DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE quick_wallets ADD COLUMN IF NOT EXISTS last_daily_claim DATE;`);
  await pool.query(`ALTER TABLE quick_wallets ALTER COLUMN chips SET DEFAULT 10000;`);
  // Solicitações de entrada em clube, aguardando aprovação do dono/admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_join_requests (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (club_id, user_id)
    );
  `);
  // Mesas configuráveis dentro de um clube — um clube pode ter várias,
  // cada uma com seu próprio tipo de jogo, blinds, rake e buy-in.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_tables (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      variant TEXT NOT NULL DEFAULT 'holdem',
      small_blind INTEGER NOT NULL,
      big_blind INTEGER NOT NULL,
      buy_in INTEGER NOT NULL,
      rake_percent NUMERIC NOT NULL DEFAULT 5,
      max_players INTEGER NOT NULL DEFAULT 9,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Histórico persistente de envio/retirada de Royalle Pay pelo dono/admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pay_ledger (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      admin_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_before BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Estatísticas simples de jogo (mesas públicas), por usuário.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      hands_played INTEGER NOT NULL DEFAULT 0,
      hands_won INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log("Banco de dados migrado com sucesso.");
}
