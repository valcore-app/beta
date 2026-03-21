import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { Pool, type PoolClient } from "pg";
import { env } from "../env.js";

let readPool: Pool | null = null;
let writePool: Pool | null = null;
let schemaReady: Promise<void> | null = null;
let activeReadUrl: string | null = null;
let activeWriteUrl: string | null = null;
let activeNetworkKey: string | null = null;
let poolRefreshInFlight: Promise<void> | null = null;

type DbRuntimeBinding = {
  networkKey: string;
  readUrl: string;
  writeUrl: string;
};

const normalizeText = (value: string | null | undefined) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
};

const isLocalDbHost = (connectionString: string) => {
  const normalized = String(connectionString ?? "").trim();
  if (!normalized) return false;

  const hostParamMatch = normalized.match(/[?&]host=([^&]+)/i);
  if (hostParamMatch?.[1]) {
    const decodedHost = decodeURIComponent(hostParamMatch[1]).trim();
    if (decodedHost.startsWith("/") || decodedHost.includes("/cloudsql/")) {
      return true;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:\/\/[^@]+@\//i.test(normalized)) {
    return true;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
};

const resolvePoolSsl = (connectionString: string) => {
  if (isLocalDbHost(connectionString)) {
    return undefined;
  }
  if (process.env.NODE_ENV === "production") {
    return {
      rejectUnauthorized: String(env.DB_SSL_REJECT_UNAUTHORIZED).toLowerCase() !== "false",
    };
  }
  return { rejectUnauthorized: false };
};

const ensurePool = (url: string) =>
  new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    ssl: resolvePoolSsl(url),
  });

const resolveRuntimeBinding = async (): Promise<DbRuntimeBinding> => {
  const readUrl = normalizeText(env.APP_READ_DATABASE_URL ?? env.APP_WRITE_DATABASE_URL);
  const writeUrl = normalizeText(env.APP_WRITE_DATABASE_URL ?? env.APP_READ_DATABASE_URL);

  if (!readUrl || !writeUrl) {
    throw new Error("APP_READ_DATABASE_URL / APP_WRITE_DATABASE_URL is required.");
  }

  const networkKey = normalizeText(env.CHAIN_KEY);
  if (!networkKey) {
    throw new Error("CHAIN_KEY is required.");
  }

  return {
    networkKey,
    readUrl,
    writeUrl,
  };
};

const ensureConfiguredPools = async () => {
  const desired = await resolveRuntimeBinding();
  const unchanged =
    readPool &&
    writePool &&
    activeReadUrl === desired.readUrl &&
    activeWriteUrl === desired.writeUrl &&
    activeNetworkKey === desired.networkKey;
  if (unchanged) {
    return;
  }

  if (!poolRefreshInFlight) {
    poolRefreshInFlight = (async () => {
      const latest = await resolveRuntimeBinding();
      const latestUnchanged =
        readPool &&
        writePool &&
        activeReadUrl === latest.readUrl &&
        activeWriteUrl === latest.writeUrl &&
        activeNetworkKey === latest.networkKey;
      if (latestUnchanged) {
        return;
      }

      await Promise.all([
        readPool ? readPool.end().catch(() => {}) : Promise.resolve(),
        writePool ? writePool.end().catch(() => {}) : Promise.resolve(),
      ]);

      readPool = ensurePool(latest.readUrl);
      writePool = ensurePool(latest.writeUrl);
      activeReadUrl = latest.readUrl;
      activeWriteUrl = latest.writeUrl;
      activeNetworkKey = latest.networkKey;
      schemaReady = null;
    })().finally(() => {
      poolRefreshInFlight = null;
    });
  }
  await poolRefreshInFlight;
};

const getReadPool = async () => {
  await ensureConfiguredPools();
  if (!readPool) {
    throw new Error("Read pool initialization failed");
  }
  return readPool;
};

const getWritePool = async () => {
  await ensureConfiguredPools();
  if (!writePool) {
    throw new Error("Write pool initialization failed");
  }
  return writePool;
};

const resolveSchemaPath = () => {
  const candidates = [
    fileURLToPath(new URL("schema.pg.sql", import.meta.url)),
    resolve(process.cwd(), "apps", "oracle", "src", "db", "schema.pg.sql"),
    resolve(process.cwd(), "src", "db", "schema.pg.sql"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error(`schema.pg.sql not found. looked at: ${candidates.join(", ")}`);
};

const ensureSchema = async () => {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = await getWritePool();
      const schemaPath = resolveSchemaPath();
      const schema = readFileSync(schemaPath, "utf-8");
      await pool.query(schema);
    })();
  }

  try {
    await schemaReady;
  } catch (error) {
    // Do not cache failed schema init forever; allow automatic retry on next request.
    schemaReady = null;
    throw error;
  }
};

export const queryRead = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => {
  await ensureSchema();
  const pool = await getReadPool();
  const result = await pool.query(sql, params);
  return result.rows as T[];
};

export const queryWrite = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => {
  await ensureSchema();
  const pool = await getWritePool();
  const result = await pool.query(sql, params);
  return result.rows as T[];
};

export const withWriteTransaction = async <T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  await ensureSchema();
  const pool = await getWritePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const closeDb = async () => {
  await Promise.all([
    readPool ? readPool.end().catch(() => {}) : Promise.resolve(),
    writePool ? writePool.end().catch(() => {}) : Promise.resolve(),
  ]);
  readPool = null;
  writePool = null;
  activeReadUrl = null;
  activeWriteUrl = null;
  activeNetworkKey = null;
  schemaReady = null;
  poolRefreshInFlight = null;
};

export const getDbRuntimeBinding = async () => {
  await ensureConfiguredPools();
  return {
    networkKey: activeNetworkKey,
    readDatabaseUrlSet: Boolean(activeReadUrl),
    writeDatabaseUrlSet: Boolean(activeWriteUrl),
  };
};

// ==================== Type definitions ====================

export type DbWeek = {
  id: string;
  start_at: string;
  lock_at: string;
  end_at: string;
  status: string;
  created_at?: string;
  finalized_at?: string | null;
};

export type DbCoinCategory = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at?: string;
};

export type DbCoin = {
  id: string;
  symbol: string;
  name: string;
  category_id: string;
  image_path: string | null;
  last_updated: string;
  created_at?: string;
};

export type DbWeekCoin = {
  week_id: string;
  coin_id: string;
  rank: number;
  position: string;
  salary: number;
  power: number;
  risk: string;
  momentum: string;
  momentum_live?: string | null;
  metrics_updated_at?: string | null;
  momentum_live_updated_at?: string | null;
};


export type DbMockLineup = {
  id?: number;
  week_id: string;
  label: string;
  address: string;
  formation_id: string;
  total_salary: number;
  lineup_hash: string;
  slots_json: string;
  created_at?: string;
};

export type DbMockScoreAggregate = {
  id?: number;
  week_id: string;
  model_key: string;
  sample_count: number;
  wins: number;
  losses: number;
  neutral: number;
  captured_at: string;
  created_at?: string;
};

export type DbLineup = {
  week_id: string;
  address: string;
  slots_json: string;
  lineup_hash: string;
  deposit_wei: string;
  principal_wei: string;
  risk_wei: string;
  swaps: number;
  created_at: string;
};

export type DbWeeklyCoinPrice = {
  id?: number;
  week_id: string;
  symbol: string;
  start_price: number | null;
  end_price: number | null;
  start_timestamp: number | null;
  end_timestamp: number | null;
  created_at?: string;
  updated_at?: string;
};

export type DbWeekShowcaseLineup = {
  week_id: string;
  formation_id: string;
  slots_json: string;
  generated_at: string;
  updated_at?: string;
};

export type DbLineupPosition = {
  id?: number;
  week_id: string;
  lineup_id: string;
  slot_id: string;
  symbol: string;
  salary_used: number;
  start_price: number;
  start_timestamp: number;
  end_price: number | null;
  end_timestamp: number | null;
  is_active: number;
  created_at?: string;
  updated_at?: string;
};

export type DbWeeklyResult = {
  id?: number;
  week_id: string;
  lineup_id: string;
  address: string;
  raw_performance: number;
  efficiency_multiplier: number;
  final_score: number;
  reward_amount_wei: string;
  created_at?: string;
};

export type DbSwapLog = {
  id?: number;
  week_id: string;
  lineup_id: string;
  swap_tx_hash: string;
  removed_symbol: string;
  added_symbol: string;
  swap_timestamp: number;
  created_at?: string;
};

export type DbFaucetClaim = {
  address: string;
  last_claim_at: string;
  last_tx_hash?: string | null;
};

export type DbJobRun = {
  id?: number;
  run_id: string;
  job_name: string;
  week_id?: string | null;
  attempt: number;
  status: string;
  error_message?: string | null;
  error_code?: string | null;
  output?: string | null;
  started_at: string;
  finished_at?: string | null;
  created_at?: string;
};


