import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const here = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(here, "..", "..", "..", ".env") });

const EnvSchema = z.object({
  ORACLE_PORT: z.string().optional(),
  ORACLE_TRUST_PROXY: z.string().default("false"),
  ORACLE_CORS_ORIGINS: z.string().default("http://localhost:3000"),
  ORACLE_ADMIN_API_KEY: z.string().optional(),
  ORACLE_STRATEGIST_API_KEY: z.string().optional(),
  ORACLE_RATE_LIMIT_WINDOW_MS: z.string().default("60000"),
  ORACLE_RATE_LIMIT_SYNC_MAX: z.string().default("60"),
  ORACLE_RATE_LIMIT_FAUCET_MAX: z.string().default("10"),
  ORACLE_RATE_LIMIT_ADMIN_MAX: z.string().default("120"),
  ORACLE_RATE_LIMIT_READ_MAX: z.string().default("240"),
  ORACLE_RATE_LIMIT_ERROR_INGEST_MAX: z.string().default("180"),
  ORACLE_MAX_SSE_CLIENTS: z.string().default("100"),


  DB_SSL_REJECT_UNAUTHORIZED: z.string().default("true"),
  APP_READ_DATABASE_URL: z.string().optional(),
  APP_WRITE_DATABASE_URL: z.string().optional(),

  ORACLE_VALCORE_CHAIN_ENABLED: z.string().default("true"),

  CHAIN_KEY: z.string().optional(),
  CHAIN_LABEL: z.string().optional(),
  CHAIN_TYPE: z.string().default("evm"),
  CHAIN_ID: z.string().optional(),
  CHAIN_RPC_URL: z.string().optional(),
  CHAIN_RPC_FALLBACK_URLS: z.string().optional(),
  CHAIN_EXPLORER_URL: z.string().optional(),
  CHAIN_NATIVE_SYMBOL: z.string().optional(),
  CHAIN_NATIVE_TOKEN_ADDRESS: z.string().optional(),
  VALCORE_ADDRESS: z.string().optional(),
  STABLECOIN_ADDRESS: z.string().optional(),
  STABLECOIN_SYMBOL: z.string().optional(),
  STABLECOIN_NAME: z.string().optional(),
  TREASURY_ADDRESS: z.string().optional(),
  DEPLOY_MOCK_STABLECOIN: z.string().default("false"),

  ORACLE_DB_PATH: z.string().default("./data/oracle.json"),
  COINGECKO_BASE_URL: z.string().default("https://api.coingecko.com/api/v3"),
  COINGECKO_API_KEY: z.string().optional(),
  REDSTONE_PRICES_URL: z.string().default("https://api.redstone.finance/prices"),
  REDSTONE_PROVIDER: z.string().default("redstone"),
  REDSTONE_REQUEST_TIMEOUT_MS: z.string().default("8000"),
  SNAPSHOT_METRICS_BINANCE_CONCURRENCY: z.string().default("6"),
  SNAPSHOT_METRICS_BINANCE_DELAY_MS: z.string().default("50"),

  ORACLE_PRIVATE_KEY: z.string().optional(),
  ORACLE_ACCOUNT_ADDRESS: z.string().optional(),
  CONTRACT_ADMIN_PRIVATE_KEY: z.string().optional(),
  CONTRACT_ADMIN_ACCOUNT_ADDRESS: z.string().optional(),
  PAUSER_PRIVATE_KEY: z.string().optional(),
  PAUSER_ACCOUNT_ADDRESS: z.string().optional(),
  FAUCET_MINTER_PRIVATE_KEY: z.string().optional(),
  FAUCET_MINTER_ACCOUNT_ADDRESS: z.string().optional(),
  AUDITOR_PRIVATE_KEY: z.string().optional(),
  AUDITOR_ACCOUNT_ADDRESS: z.string().optional(),
  SENTINEL_PRIVATE_KEY: z.string().optional(),
  SENTINEL_ACCOUNT_ADDRESS: z.string().optional(),
  SENTINEL_STABLECOIN_DEPOSIT: z.string().default("120"),
  AUDITOR_ADDRESS: z.string().optional(),
  STARKNET_TYPED_DATA_CHAIN_ID: z.string().optional(),
  DEPLOYER_PRIVATE_KEY: z.string().optional(),
  DEPLOYER_ACCOUNT_ADDRESS: z.string().optional(),
  TREASURY_PRIVATE_KEY: z.string().optional(),

  PRINCIPAL_RATIO_BPS: z.string().default("8000"),
  PROTOCOL_FEE_BPS: z.string().default("1000"),
  STABLECOIN_DECIMALS: z.string().default("18"),
  FAUCET_STABLECOIN_AMOUNT: z.string().default("200"),
  FAUCET_COOLDOWN_HOURS: z.string().default("24"),
  DRAFT_OPEN_HOURS: z.string().default("23"),
  WEEK_DURATION_DAYS: z.string().default("6"),
  COOLDOWN_HOURS: z.string().default("1"),
  AUTOMATION_MODE: z.string().default("CRON"),
  AUTOMATION_TICK_MS: z.string().default("15000"),
  AUTOMATION_REACTIVE_AUTO_AUDIT: z.string().default("true"),
  RUN_WEEK_BASE_TIME_MS: z.string().optional(),

  JOB_RETRY_BASE_MS: z.string().default("5000"),
  JOB_RETRY_MAX_MS: z.string().default("60000"),
  JOB_RETRY_JITTER_MS: z.string().default("1500"),
  JOB_RETRY_MAX_ATTEMPTS: z.string().default("0"),
  JOB_TIMEOUT_MS: z.string().default("0"),
  JOB_RUN_WEEK_TIMEOUT_MS: z.string().default("1200000"),
  JOB_WEBHOOK_URL: z.string().optional(),
  JOB_WEBHOOK_API_KEY: z.string().optional(),

  ERROR_ALERTS_ENABLED: z.string().default("false"),
  ERROR_ALERT_WINDOW_MINUTES: z.string().default("5"),
  ERROR_ALERT_THRESHOLD: z.string().default("20"),
  ERROR_ALERT_MIN_SEVERITY: z.enum(["warn", "error", "fatal"]).default("error"),
  ERROR_ALERT_COOLDOWN_MINUTES: z.string().default("15"),
  ERROR_ALERT_WEBHOOK_URL: z.string().optional(),
  ERROR_ALERT_WEBHOOK_API_KEY: z.string().optional(),
  ERROR_ALERT_STARKNET_WEBHOOK_URL: z.string().optional(),
  ERROR_ALERT_STARKNET_WEBHOOK_API_KEY: z.string().optional(),
  ERROR_ALERT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  ERROR_ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
  ERROR_ALERT_STARKNET_TELEGRAM_CHAT_ID: z.string().optional(),

  SELF_HEAL_POLL_MS: z.string().default("5000"),
  SELF_HEAL_BATCH_SIZE: z.string().default("5"),
  SELF_HEAL_BASE_MS: z.string().default("4000"),
  SELF_HEAL_MAX_MS: z.string().default("120000"),
  SELF_HEAL_JITTER_MS: z.string().default("1200"),
  SELF_HEAL_DEFAULT_MAX_ATTEMPTS: z.string().default("12"),
  MOCK_SCORE_SNAPSHOT_INTERVAL_MS: z.string().default("600000"),
  START_WEEK_MOCK_LINEUP_COUNT: z.string().default("100"),

  CHAIN_TX_RETRY_BASE_MS: z.string().default("1500"),
  CHAIN_TX_MAX_ATTEMPTS: z.string().default("4"),
  CHAIN_TX_FEE_BUMP_BPS: z.string().default("1500"),
  CHAIN_TX_GAS_LIMIT_BUFFER_BPS: z.string().default("2000"),
  CHAIN_TX_CONFIRMATIONS: z.string().default("1"),
});

export const env = EnvSchema.parse(process.env);









