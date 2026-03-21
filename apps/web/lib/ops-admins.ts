import { Pool } from "pg";
import { resolveDbSsl } from "./db-ssl";

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

const getPool = () => {
  if (pool) return pool;
  const url =
    process.env.AUTH_DATABASE_URL ??
    process.env.APP_WRITE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AUTH_DATABASE_URL or APP_WRITE_DATABASE_URL is required for ops admin checks.",
    );
  }
  pool = new Pool({
    connectionString: url,
    ssl: resolveDbSsl(url),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  return pool;
};

const ensureSchema = async () => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS ops_admins (
        email TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    await getPool().query(sql);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
};

export const isOpsAdmin = async (email?: string | null) => {
  if (!email) return false;
  await ensureSchema();
  const normalized = email.trim().toLowerCase();
  const res = await getPool().query("SELECT 1 FROM ops_admins WHERE email = $1", [normalized]);
  return (res.rowCount ?? 0) > 0;
};

export const addOpsAdmin = async (email: string) => {
  if (!email) return;
  await ensureSchema();
  const normalized = email.trim().toLowerCase();
  await getPool().query(
    "INSERT INTO ops_admins (email) VALUES ($1) ON CONFLICT (email) DO NOTHING",
    [normalized],
  );
};

export const closeOpsAdminPool = async () => {
  if (!pool) return;
  await pool.end();
  pool = null;
  schemaReady = null;
};

