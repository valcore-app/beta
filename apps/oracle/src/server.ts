import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { env } from "./env.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomBytes } from "crypto";
import {
    getWeeks,
    getWeekById,
    getWeekCoins,
    getCoins,
    getLineups,
    getAllLineups,
    getLineupByAddress,
    getWeeklyResults,
    getAllWeeklyResults,
    getLeaderboardRows,
    getSwapLogByWeek,
    getFaucetClaim,
    upsertFaucetClaim,
    getPlayerProfile,
    getPlayerProfileByDisplayName,
    upsertPlayerProfile,
    listJobRunIncidents,
    getMockLineups,
    getWeekShowcaseLineup,
    upsertWeekShowcaseLineup,
    createLineupTxIntent,
    getLineupTxIntentById,
    getLineupTxIntentByTxHash,
    markLineupTxIntentSubmitted,
    markLineupTxIntentHealing,
    markLineupTxIntentCompleted,
    markLineupTxIntentFailed,
    expireStalePreparedLineupTxIntents,
    clearMockScoreAggregates,
    insertErrorEvent,
    listErrorEvents,
    getErrorEventById,
    acknowledgeErrorEvent,
    getErrorEventsSummary,
    listErrorIncidents,
    getErrorIncidentsSummary,
    setErrorIncidentState,
    listErrorSuppressRules,
    createErrorSuppressRule,
    updateErrorSuppressRule,
    deleteErrorSuppressRule,
    getStrategyById,
    getStrategyEpochEntries,
    getEpochStrategies,
    getStrategyLeaderboardRows,
    getStrategySeasonEntries,
    listLifecycleReactiveEvents,
} from "./store.js";
import { getLineupPositions, getWeeklyCoinPrices } from "./services/weekPricing.service.js";
import { calculateLineupWeekScore, computeBenchmarkPnlPercent, getWeekScoreModelCatalog, WEEK_SCORE_MODEL_ORDER } from "./services/weekScore.service.js";
import { captureActiveWeekMockLineupScoreSnapshot, generateMockLineups, getMockLineupLiveScores, getMockLineupSnapshotAnalytics, getMockLineupSnapshotComparison, getMockLineupSnapshotModelMatrix, } from "./services/mockLineup.service.js";
import { resolveDataDir } from "./paths.js";
import { existsSync } from "fs";
import { getLivePrices } from "./services/priceOracle.service.js";
import { hasRunningJob, listJobStatuses, startJob, stopJob, jobsEvents } from "./admin/jobs.js";
import { cancelSelfHealTaskById, enqueueLineupSyncTask, getSelfHealDashboard, retrySelfHealTaskById, runSelfHealSweep, startSelfHealWorker, } from "./admin/self-heal.js";
import { getErrorAlertPublicConfig, maybeTriggerErrorAlert } from "./admin/error-alerts.js";
import { getAutomationSupportReason, getDerivedTimeMode, isReactiveSupported, normalizeAutomationMode } from "./admin/automation.js";
import { reconcileWeekStatusDrift } from "./jobs/week-drift.js";
import { ethers } from "ethers";
import { getDbRuntimeBinding } from "./db/db.js";
import {
    getRequiredRuntimeOraclePrivateKey,
    getRuntimeChainConfig,
    getRuntimeProvider,
    withRuntimeStarknetProvider,
    getRuntimeValcoreAddress,
    isValcoreChainEnabled,
} from "./network/chain-runtime.js";
import { sendTxWithPolicy } from "./network/tx-policy.js";
import {
    getOnchainFeeBps,
    getOnchainPosition,
    mintStablecoinOnchain,
} from "./network/valcore-chain-client.js";
const parseBoolean = (value: unknown) => String(value ?? "").trim().toLowerCase() === "true";
const toPositiveInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
const trustProxy = parseBoolean(env.ORACLE_TRUST_PROXY);
const server = Fastify({ logger: true, trustProxy });
const corsAllowlist = String(env.ORACLE_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
const isOriginAllowed = (origin: string | undefined) => {
    if (!origin)
        return true;
    if (corsAllowlist.length === 0)
        return true;
    return corsAllowlist.includes(origin);
};
const readAdminApiKey = (request: FastifyRequest) => {
    const direct = request.headers["x-admin-api-key"];
    if (typeof direct === "string" && direct.trim())
        return direct.trim();
    const auth = request.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
    }
    return "";
};
const readPlayerApiKey = (request: FastifyRequest) => {
    const direct = request.headers["x-strategist-api-key"];
    if (typeof direct === "string" && direct.trim())
        return direct.trim();
    return "";
};
const isAdminAuthorized = (request: FastifyRequest) => {
    const expected = String(env.ORACLE_ADMIN_API_KEY ?? "").trim();
    if (!expected) {
        return process.env.NODE_ENV !== "production";
    }
    return readAdminApiKey(request) === expected;
};
const isStrategistAuthorized = (request: FastifyRequest) => {
    const expected = String(env.ORACLE_STRATEGIST_API_KEY ?? "").trim();
    if (!expected) {
        return process.env.NODE_ENV !== "production";
    }
    return readPlayerApiKey(request) === expected;
};
const resolveClientIp = (request: FastifyRequest) => {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
        return forwarded.split(",")[0].trim();
    }
    return request.ip || "unknown";
};
const RATE_LIMIT_WINDOW_MS = toPositiveInt(env.ORACLE_RATE_LIMIT_WINDOW_MS, 60000);
const RATE_LIMIT_SYNC_MAX = toPositiveInt(env.ORACLE_RATE_LIMIT_SYNC_MAX, 60);
const RATE_LIMIT_FAUCET_MAX = toPositiveInt(env.ORACLE_RATE_LIMIT_FAUCET_MAX, 10);
const RATE_LIMIT_ADMIN_MAX = toPositiveInt(env.ORACLE_RATE_LIMIT_ADMIN_MAX, 120);
const RATE_LIMIT_READ_MAX = toPositiveInt(env.ORACLE_RATE_LIMIT_READ_MAX, 240);
const RATE_LIMIT_ERROR_INGEST_MAX = toPositiveInt(env.ORACLE_RATE_LIMIT_ERROR_INGEST_MAX, 180);
const MAX_SSE_CLIENTS = toPositiveInt(env.ORACLE_MAX_SSE_CLIENTS, 100);
const SHOWCASE_REFRESH_MS = 4 * 60 * 60 * 1000;
const PREPARED_INTENT_SWEEP_MS = 30 * 1000;
const PREPARED_INTENT_EXPIRE_SECONDS = 180;
const SHOWCASE_FORMATION_ID = "4-4-2";
const SHOWCASE_SLOTS = [
    { slotId: "core-1", position: "GK" },
    { slotId: "stabilizer-1", position: "DEF" },
    { slotId: "stabilizer-2", position: "DEF" },
    { slotId: "stabilizer-3", position: "DEF" },
    { slotId: "stabilizer-4", position: "DEF" },
    { slotId: "amplifier-1", position: "MID" },
    { slotId: "amplifier-2", position: "MID" },
    { slotId: "amplifier-3", position: "MID" },
    { slotId: "amplifier-4", position: "MID" },
    { slotId: "wildcard-1", position: "FWD" },
    { slotId: "wildcard-2", position: "FWD" },
];
const PLAYER_PROFILE_NONCE_TTL_MS = 5 * 60 * 1000;
const playerProfileNonces = new Map<string, { nonce: string; expiresAt: number }>();
const SN_MAIN = "0x534e5f4d41494e";
const SN_SEPOLIA = "0x534e5f5345504f4c4941";

const toHexFelt = (value: string) => {
    const raw = String(value ?? "").trim();
    if (!raw)
        return "0x0";
    if (raw.startsWith("0x") || raw.startsWith("0X"))
        return raw.toLowerCase();
    return `0x${raw.toLowerCase()}`;
};

const resolveStarknetTypedDataChainId = (networkKey: string) => {
    const explicit = String(env.STARKNET_TYPED_DATA_CHAIN_ID ?? "").trim();
    if (explicit)
        return explicit;
    const key = String(networkKey ?? "").toLowerCase();
    if (key.includes("mainnet") || key.endsWith("_main"))
        return SN_MAIN;
    return SN_SEPOLIA;
};

const buildStarknetPlayerNameApprovalTypedData = (
    _address: string,
    displayName: string,
    nonce: string,
    chainId: string,
) => ({
    types: {
        StarknetDomain: [
            { name: "name", type: "felt" },
            { name: "version", type: "felt" },
            { name: "chainId", type: "felt" },
        ],
        PlayerNameApproval: [
            { name: "display_name_hash", type: "felt" },
            { name: "nonce", type: "felt" },
        ],
    },
    primaryType: "PlayerNameApproval",
    domain: {
        name: "Valcore",
        version: "1",
        chainId,
    },
    message: {
        display_name_hash: ethers.id(displayName),
        nonce: toHexFelt(nonce),
    },
});

const normalizeStarknetSignature = (value: unknown): string[] | null => {
    if (!Array.isArray(value))
        return null;
    const normalized = value
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => /^0x[a-fA-F0-9]+$/u.test(entry))
        .map((entry) => entry.toLowerCase());
    if (!normalized.length)
        return null;
    return normalized;
};
const buildPlayerNameApprovalMessage = (address: string, displayName: string, nonce: string) => {
    return [
        "Valcore Strategist Name Approval",
        `Address: ${address.toLowerCase()}`,
        `Display Name: ${displayName}`,
        `Nonce: ${nonce}`,
    ].join("\n");
};
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of playerProfileNonces.entries()) {
        if (value.expiresAt <= now) playerProfileNonces.delete(key);
    }
}, 60 * 1000).unref();
const rateLimitBuckets = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets.entries()) {
        if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
}, 5 * 60 * 1000).unref();
const cleanupRateLimitBuckets = (nowMs: number) => {
    if (rateLimitBuckets.size < 5000)
        return;
    for (const [key, bucket] of rateLimitBuckets.entries()) {
        if (bucket.resetAt <= nowMs) {
            rateLimitBuckets.delete(key);
        }
    }
};
const enforceRateLimit = (scope: string, request: FastifyRequest, maxRequests: number, reply: FastifyReply) => {
    const nowMs = Date.now();
    cleanupRateLimitBuckets(nowMs);
    const ip = resolveClientIp(request);
    const key = `${scope}:${ip}`;
    const existing = rateLimitBuckets.get(key);
    if (!existing || existing.resetAt <= nowMs) {
        rateLimitBuckets.set(key, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    existing.count += 1;
    if (existing.count > maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000));
        reply.header("Retry-After", String(retryAfterSeconds));
        reply.code(429).send({ error: "Too many requests", retryAfterSeconds });
        return false;
    }
    return true;
};
const isReadLimitedPath = (path: string) => {
    if (path === "/prices/live" || path === "/weeks/current" || path === "/weeks") {
        return true;
    }
    if (/^\/weeks\/[^/]+\/coins$/.test(path)) {
        return true;
    }
    if (/^\/weeks\/[^/]+\/reactive-flow$/.test(path)) {
        return true;
    }
    if (/^\/weeks\/[^/]+\/showcase-lineup$/.test(path)) {
        return true;
    }
    if (/^\/weeks\/[^/]+\/lineups\/[^/]+$/.test(path)) {
        return true;
    }
    if (/^\/weeks\/[^/]+\/lineups\/[^/]+\/score$/.test(path)) {
        return true;
    }
    if (/^\/strategies\/[^/]+$/.test(path)) {
        return true;
    }
    if (/^\/epochs\/[^/]+\/strategies$/.test(path)) {
        return true;
    }
    if (path === "/leaderboard/strategies") {
        return true;
    }
    if (/^\/strategists\/[^/]+\/profile$/.test(path)) {
        return true;
    }
    if (path === "/strategists/name-availability") {
        return true;
    }
    return false;
};
const isLineupIntentSubmitPath = (path: string) => /^\/lineups\/intents\/[^/]+\/submit$/.test(path);
const isErrorIngestPath = (method: string, path: string) => method === "POST" && path === "/errors/ingest";
const isStrategistWritePath = (method: string, path: string) =>
    method === "POST" &&
    (path === "/lineups/sync" ||
        path === "/lineups/intents" ||
        isLineupIntentSubmitPath(path) ||
        path === "/faucet" ||
        path === "/strategists/profile" ||
        path === "/strategists/profile/nonce" ||
        path === "/errors/ingest");
await server.register(cors, {
    origin: (origin, callback) => {
        callback(null, isOriginAllowed(origin));
    },
});
server.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] || "/";
    const method = String(request.method ?? "GET").toUpperCase();
    if (isStrategistWritePath(method, path) && !isStrategistAuthorized(request)) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
    }
    if ((path === "/lineups/sync" || path === "/lineups/intents" || isLineupIntentSubmitPath(path)) && !enforceRateLimit("lineup_sync", request, RATE_LIMIT_SYNC_MAX, reply)) {
        return;
    }
    if (path === "/faucet" && !enforceRateLimit("faucet", request, RATE_LIMIT_FAUCET_MAX, reply)) {
        return;
    }
    if ((path === "/strategists/profile" || path === "/strategists/profile/nonce") && !enforceRateLimit("strategist_profile", request, RATE_LIMIT_SYNC_MAX, reply)) {
        return;
    }
    if (isErrorIngestPath(method, path) && !enforceRateLimit("errors_ingest", request, RATE_LIMIT_ERROR_INGEST_MAX, reply)) {
        return;
    }
    if (method === "GET" && isReadLimitedPath(path)) {
        if (!enforceRateLimit("read", request, RATE_LIMIT_READ_MAX, reply)) {
            return;
        }
    }
    if (path.startsWith("/admin/")) {
        if (!enforceRateLimit("admin", request, RATE_LIMIT_ADMIN_MAX, reply)) {
            return;
        }
        if (!isAdminAuthorized(request)) {
            reply.code(401).send({ error: "Unauthorized" });
            return;
        }
    }
});
server.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    const proto = request.headers["x-forwarded-proto"];
    const isHttps = String(proto ?? request.protocol ?? "").toLowerCase().includes("https");
    if (isHttps) {
        reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
});
server.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: "Invalid request" });
    }
    request.log.error(error);
    void insertErrorEvent({
        event_id: String(Date.now()) + "-" + Math.random().toString(16).slice(2),
        source: "oracle-server",
        severity: "error",
        category: "unhandled",
        message: error instanceof Error ? error.message : "Unhandled server error",
        error_name: error instanceof Error ? error.name : "UnknownError",
        stack: error instanceof Error ? error.stack ?? null : null,
        path: request.url,
        method: request.method,
        status_code: 500,
        context_json: JSON.stringify({ route: (request as { routerPath?: string }).routerPath ?? null }),
        user_agent: String(request.headers["user-agent"] ?? "").slice(0, 1024),
        ip_address: resolveClientIp(request),
        created_at: new Date().toISOString(),
    }).catch(() => {});
    return reply.code(500).send({ error: "Internal server error" });
});
const ErrorSeveritySchema = z.enum(["warn", "error", "fatal"]).default("error");
const ErrorAckStateSchema = z.enum(["all", "acked", "unacked"]).default("all");
const ErrorIngestSchema = z.object({
    eventId: z.string().trim().min(1).max(120).optional(),
    source: z.string().trim().min(1).max(64).default("web-client"),
    severity: ErrorSeveritySchema,
    category: z.string().trim().min(1).max(64).default("runtime"),
    message: z.string().trim().min(1).max(4000),
    errorName: z.string().trim().min(1).max(200).optional(),
    stack: z.string().trim().min(1).max(30000).optional(),
    fingerprint: z.string().trim().min(1).max(200).optional(),
    path: z.string().trim().min(1).max(500).optional(),
    method: z.string().trim().min(1).max(16).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    context: z.unknown().optional(),
    tags: z.record(z.string().trim().max(80)).optional(),
    release: z.string().trim().min(1).max(120).optional(),
    sessionAddress: z.string().trim().min(1).max(120).optional(),
    walletAddress: z.string().trim().min(1).max(120).optional(),
    strategistDisplayName: z.string().trim().min(1).max(64).optional(),
    userAgent: z.string().trim().min(1).max(1024).optional(),
});
const ErrorIncidentStateSchema = z.enum(["new", "actionable", "suppressed", "fixed-monitoring", "closed"]);
const ErrorActionableSchema = z.enum(["all", "actionable", "non-actionable"]).default("all");
const ErrorListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    severity: z.string().trim().min(1).max(32).optional(),
    source: z.string().trim().min(1).max(64).optional(),
    category: z.string().trim().min(1).max(64).optional(),
    q: z.string().trim().max(200).optional(),
    ack: ErrorAckStateSchema.optional(),
    actionable: ErrorActionableSchema.optional(),
    incidentState: ErrorIncidentStateSchema.optional(),
});
const ErrorSummaryQuerySchema = z.object({
    windowHours: z.coerce.number().int().min(1).max(720).default(24),
});
const ErrorIncidentListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    state: ErrorIncidentStateSchema.optional(),
    source: z.string().trim().min(1).max(64).optional(),
    q: z.string().trim().max(200).optional(),
});
const ErrorSuppressRuleInputSchema = z.object({
    name: z.string().trim().min(2).max(120),
    enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
    source: z.string().trim().max(64).optional(),
    category: z.string().trim().max(64).optional(),
    fingerprint: z.string().trim().max(220).optional(),
    pathPattern: z.string().trim().max(500).optional(),
    method: z.string().trim().max(16).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    messagePattern: z.string().trim().max(300).optional(),
    severity: z.string().trim().max(16).optional(),
    notes: z.string().trim().max(500).optional(),
});
const ErrorSuppressRulePatchSchema = ErrorSuppressRuleInputSchema.partial().extend({
    enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
});
const safeJsonStringify = (value: unknown, maxLength = 10000) => {
    if (value === undefined) {
        return null;
    }
    try {
        const text = JSON.stringify(value);
        if (!text) {
            return null;
        }
        return text.length > maxLength ? text.slice(0, maxLength) : text;
    }
    catch {
        return null;
    }
};
const runtimeChainType = String(env.CHAIN_TYPE ?? "evm").trim().toLowerCase();
const normalizeAddressByChain = (value: unknown, chainType = runtimeChainType) => {
    const raw = String(value ?? "").trim();
    if (!raw)
        return null;
    if (chainType === "starknet") {
        if (!/^0x[a-fA-F0-9]{1,64}$/u.test(raw)) {
            return null;
        }
        return raw.toLowerCase();
    }
    try {
        return ethers.getAddress(raw).toLowerCase();
    }
    catch {
        return null;
    }
};
const normalizeMaybeAddress = (value: unknown) => normalizeAddressByChain(value);
const WeekRowSchema = z.object({
    id: z.string(),
    start_at: z.string(),
    lock_at: z.string(),
    end_at: z.string(),
    status: z.string(),
    finalized_at: z.string().nullable().optional(),
});
const COOLDOWN_HOURS = Math.max(0, Number(env.COOLDOWN_HOURS ?? "1") || 1);
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;
const AUTOMATION_TICK_MS = toPositiveInt(env.AUTOMATION_TICK_MS, 15000);
const AUTOMATION_REACTIVE_AUTO_AUDIT = parseBoolean(env.AUTOMATION_REACTIVE_AUTO_AUDIT);
const AUTOMATION_UNSUPPORTED_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const REACTIVE_STALL_GRACE_MS = Math.max(30 * 1000, toPositiveInt(env.REACTIVE_STALL_GRACE_SECONDS, 120) * 1000);
const REWARD_SWEEP_DELAY_MS = 180 * 24 * 60 * 60 * 1000;
const PUBLIC_WEEK_STATUSES = new Set(["PREPARING", "DRAFT_OPEN", "LOCKED", "ACTIVE", "FINALIZE_PENDING", "FINALIZED"]);
const filterPublicWeeks = (rows: unknown[]) => rows.filter((row) => PUBLIC_WEEK_STATUSES.has(String((row as Record<string, unknown>).status ?? "").toUpperCase()));
const getCurrentPublicWeek = (rows: unknown[]) => filterPublicWeeks(rows)[0] ?? null;
const buildCooldownEndIso = (finalizedAt: string | null | undefined) => {
    if (!finalizedAt)
        return null;
    const finalizedMs = Date.parse(finalizedAt);
    if (!Number.isFinite(finalizedMs))
        return null;
    return new Date(finalizedMs + COOLDOWN_MS).toISOString();
};
const buildPublicWeekPayload = (parsed: z.infer<typeof WeekRowSchema>) => ({
    id: parsed.id,
    startAtUtc: parsed.start_at,
    lockAtUtc: parsed.lock_at,
    endAtUtc: parsed.end_at,
    status: parsed.status,
    finalizedAtUtc: parsed.finalized_at ?? null,
    cooldownEndsAtUtc: buildCooldownEndIso(parsed.finalized_at ?? null),
});
let sseClientId = 0;
const sseClients = new Map();
const buildWeekSnapshot = async () => {
    const weeks = await getWeeks();
    const row = getCurrentPublicWeek(weeks);
    if (!row) {
        return {
            id: null,
            startAtUtc: null,
            lockAtUtc: null,
            endAtUtc: null,
            status: null,
            finalizedAtUtc: null,
            cooldownEndsAtUtc: null,
        };
    }
    const parsed = WeekRowSchema.parse(row);
    return buildPublicWeekPayload(parsed);
};
const snapshotSignature = (snapshot: { id?: string | null; status?: string | null; startAtUtc?: string | null; lockAtUtc?: string | null; endAtUtc?: string | null; finalizedAtUtc?: string | null; cooldownEndsAtUtc?: string | null }) => `${snapshot.id ?? "none"}|${snapshot.status ?? "none"}|${snapshot.startAtUtc ?? ""}|${snapshot.lockAtUtc ?? ""}|${snapshot.endAtUtc ?? ""}|${snapshot.finalizedAtUtc ?? ""}|${snapshot.cooldownEndsAtUtc ?? ""}`;
const automationHaltState: {
    halted: boolean;
    reason: string | null;
    activatedAt: string | null;
    contextJson: string | null;
} = {
    halted: false,
    reason: null,
    activatedAt: null,
    contextJson: null,
};
const getEffectiveAutomationMode = (baseMode: string) => normalizeAutomationMode(baseMode);
const haltAutomation = async (reason: string, context?: Record<string, unknown>) => {
    const baseMode = normalizeAutomationMode(env.AUTOMATION_MODE);
    const payload = {
        baseMode,
        reason,
        context: context ?? null,
    };
    if (!automationHaltState.halted) {
        automationHaltState.halted = true;
        automationHaltState.reason = reason;
        automationHaltState.activatedAt = new Date().toISOString();
        automationHaltState.contextJson = context ? safeJsonStringify(context, 4000) : null;
    }
    server.log.error(payload, "automation halted (strict reactive mode)");
    await insertErrorEvent({
        event_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        source: "oracle-automation",
        severity: "error",
        category: "automation",
        message: `Automation halted. ${reason}`,
        path: "/automation/halt",
        method: "SYSTEM",
        status_code: 422,
        context_json: safeJsonStringify(payload),
        created_at: new Date().toISOString(),
    }).catch(() => { });
};
const resolveAutomationRuntime = async () => {
    const runtime = await getRuntimeChainConfig().catch(() => null);
    const baseMode = normalizeAutomationMode(env.AUTOMATION_MODE);
    const mode = getEffectiveAutomationMode(baseMode);
    const timeMode = getDerivedTimeMode(mode);
    const fallbackChainIdRaw = runtime?.chainId ?? env.CHAIN_ID ?? process.env.CHAIN_ID ?? null;
    const fallbackChainId = Number(fallbackChainIdRaw);
    const inferredChainType = Number.isFinite(fallbackChainId) && fallbackChainId === 534351 ? "non-evm" : "evm";
    const chainType = String(runtime?.chainType ?? inferredChainType).trim().toLowerCase();
    const chainId = runtime?.chainId ?? env.CHAIN_ID ?? null;
    const chainKey = String(runtime?.networkKey ?? env.CHAIN_KEY ?? "").trim().toLowerCase();
    const reactiveSupported = isReactiveSupported({ chainType, chainId, chainKey });
    const supportReason = getAutomationSupportReason({ chainType, chainId, chainKey });
    return {
        baseMode,
        mode,
        timeMode,
        chainType,
        chainId,
        chainKey,
        reactiveSupported,
        supportReason,
        failoverActive: automationHaltState.halted,
        failoverMode: automationHaltState.halted ? "HALT" : null,
        failoverReason: automationHaltState.reason,
        failoverActivatedAt: automationHaltState.activatedAt,
        failoverContextJson: automationHaltState.contextJson,
    };
};
const areClaimsUnlockedForWeek = async (weekId: string) => {
    const weeks = await getWeeks();
    const target = weeks.find((row) => String(row.id) === String(weekId));
    if (!target)
        return false;
    const targetStatus = String(target.status ?? "").toUpperCase();
    if (targetStatus !== "FINALIZED")
        return false;
    const targetStartMs = Date.parse(String(target.start_at ?? ""));
    if (!Number.isFinite(targetStartMs))
        return false;
    return weeks.some((row) => {
        if (String(row.id) === String(weekId))
            return false;
        const startMs = Date.parse(String(row.start_at ?? ""));
        return Number.isFinite(startMs) && startMs > targetStartMs;
    });
};
const getShowcaseFromCache = (cached: { week_id: string; formation_id: string; slots_json: string; generated_at: string } | null | undefined) => {
    if (!cached)
        return null;
    const generatedAtMs = Date.parse(cached.generated_at);
    if (!Number.isFinite(generatedAtMs))
        return null;
    if (Date.now() - generatedAtMs >= SHOWCASE_REFRESH_MS)
        return null;
    let slots = [];
    try {
        const parsed = JSON.parse(cached.slots_json);
        if (!Array.isArray(parsed))
            return null;
        slots = parsed
            .filter((item) => item && typeof item.slotId === "string" && typeof item.coinId === "string")
            .map((item) => ({ slotId: item.slotId, coinId: item.coinId }));
    }
    catch {
        return null;
    }
    if (!slots.length)
        return null;
    return {
        weekId: cached.week_id,
        formationId: cached.formation_id,
        generatedAt: cached.generated_at,
        refreshIntervalSeconds: Math.floor(SHOWCASE_REFRESH_MS / 1000),
        slots,
    };
};
const buildShowcaseLineup = async (weekId: string) => {
    const weekCoins = await getWeekCoins(weekId);
    if (!weekCoins.length) {
        return null;
    }
    const allCoins = await getCoins();
    const coinById = new Map(allCoins.map((coin) => [coin.id, coin]));
    const weeklyPrices = await getWeeklyCoinPrices(weekId);
    const startPriceBySymbol = new Map(weeklyPrices
        .filter((row) => row.start_price !== null && Number(row.start_price) > 0)
        .map((row) => [row.symbol.toUpperCase(), Number(row.start_price)]));
    const symbols = Array.from(new Set(weekCoins
        .map((row) => coinById.get(row.coin_id)?.symbol?.toUpperCase() ?? "")
        .filter(Boolean)));
    const livePricesRaw = symbols.length ? await getLivePrices(symbols) : {};
    const livePriceBySymbol = new Map(Object.entries(livePricesRaw)
        .map(([symbol, value]) => [symbol.toUpperCase(), Number(value)])
        .filter(([, value]) => Number.isFinite(value as number) && (value as number) > 0) as [string, number][]);
    type EnrichedItem = { coinId: string; position: string; rank: number; hasValidPnl: boolean; pnlPercent: number | null };
    const enriched = weekCoins
        .map((row) => {
        const coin = coinById.get(row.coin_id);
        if (!coin?.symbol)
            return null;
        const symbol = coin.symbol.toUpperCase();
        const startPrice = startPriceBySymbol.get(symbol) ?? null;
        const livePrice = livePriceBySymbol.get(symbol) ?? null;
        const hasValidPnl =
            typeof startPrice === "number" &&
                startPrice > 0 &&
                typeof livePrice === "number" &&
                livePrice > 0;
        const pnlPercent = hasValidPnl ? (livePrice / startPrice - 1) * 100 : null;
        return {
            coinId: row.coin_id,
            position: row.position,
            rank: Number(row.rank) || 0,
            hasValidPnl,
            pnlPercent,
        };
    })
        .filter((item): item is EnrichedItem => item !== null);
    if (!enriched.length) {
        return null;
    }
    const requiredByPosition: Record<string, number> = {
        GK: 1,
        DEF: 4,
        MID: 4,
        FWD: 2,
    };
    const selectedByPosition: Record<string, EnrichedItem[]> = {
        GK: [],
        DEF: [],
        MID: [],
        FWD: [],
    };
    const sortedByPosition = (position: string) => enriched
        .filter((item) => item.position === position)
        .sort((a, b) => {
        if (a.hasValidPnl !== b.hasValidPnl) {
            return a.hasValidPnl ? -1 : 1;
        }
        if (a.hasValidPnl && b.hasValidPnl) {
            const pnlDiff = (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0);
            if (Math.abs(pnlDiff) > 0.000001)
                return pnlDiff;
        }
        return a.rank - b.rank;
    });
    for (const position of Object.keys(requiredByPosition)) {
        const list = sortedByPosition(position);
        const limit = requiredByPosition[position] ?? 0;
        selectedByPosition[position] = list.slice(0, limit);
    }
    const usedCoinIds = new Set(Object.values(selectedByPosition)
        .flat()
        .map((item) => item.coinId));
    if (usedCoinIds.size < SHOWCASE_SLOTS.length) {
        const fallback = [...enriched]
            .filter((item) => !usedCoinIds.has(item.coinId))
            .sort((a, b) => {
            if (a.hasValidPnl !== b.hasValidPnl)
                return a.hasValidPnl ? -1 : 1;
            if (a.hasValidPnl && b.hasValidPnl) {
                const pnlDiff = (b.pnlPercent ?? 0) - (a.pnlPercent ?? 0);
                if (Math.abs(pnlDiff) > 0.000001)
                    return pnlDiff;
            }
            return a.rank - b.rank;
        });
        for (const candidate of fallback) {
            const targetPool = selectedByPosition[candidate.position] ?? [];
            const targetSize = requiredByPosition[candidate.position] ?? 0;
            if (targetPool.length >= targetSize)
                continue;
            targetPool.push(candidate);
            usedCoinIds.add(candidate.coinId);
            if (usedCoinIds.size >= SHOWCASE_SLOTS.length)
                break;
        }
    }
    const slotsByPosition: Record<string, string[]> = {
        GK: selectedByPosition.GK.map((item) => item.coinId),
        DEF: selectedByPosition.DEF.map((item) => item.coinId),
        MID: selectedByPosition.MID.map((item) => item.coinId),
        FWD: selectedByPosition.FWD.map((item) => item.coinId),
    };
    const slots = SHOWCASE_SLOTS.map((slot) => {
        const nextCoinId = slotsByPosition[slot.position].shift() ?? null;
        return {
            slotId: slot.slotId,
            coinId: nextCoinId,
        };
    }).filter((slot) => Boolean(slot.coinId));
    if (!slots.length) {
        return null;
    }
    const generatedAt = new Date().toISOString();
    await upsertWeekShowcaseLineup({
        week_id: weekId,
        formation_id: SHOWCASE_FORMATION_ID,
        slots_json: JSON.stringify(slots),
        generated_at: generatedAt,
    });
    return {
        weekId,
        formationId: SHOWCASE_FORMATION_ID,
        generatedAt,
        refreshIntervalSeconds: Math.floor(SHOWCASE_REFRESH_MS / 1000),
        slots,
    };
};
const parseLineupSlots = (slotsJson: string | null | undefined) => {
    try {
        const parsed = JSON.parse(slotsJson ?? "[]");
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .filter((item) => item && typeof item.slotId === "string" && typeof item.coinId === "string")
            .map((item) => ({ slotId: item.slotId, coinId: item.coinId }));
    }
    catch {
        return [];
    }
};
const resolveLeagueAddress = async () => (isValcoreChainEnabled() ? await getRuntimeValcoreAddress() : null);
const readWeekJsonFile = (prefix: string, weekId: string) => {
    const fileName = `${prefix}-${weekId}.json`;
    const candidates = [
        resolve(resolveDataDir(), fileName),
        resolve(process.cwd(), "apps", "oracle", "data", fileName),
        resolve(process.cwd(), "data", fileName),
    ];
    const filePath = candidates.find((candidate) => existsSync(candidate));
    if (!filePath)
        return null;
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
};
const readClaimsForWeek = (weekId: string) => {
    const claimsRaw = readWeekJsonFile("claims", weekId);
    if (!Array.isArray(claimsRaw))
        return new Map();
    const claims = new Map();
    for (const entry of claimsRaw) {
        const address = String(entry?.address ?? "").toLowerCase();
        if (!address)
            continue;
        const proof = Array.isArray(entry?.proof)
            ? entry.proof.filter((value: unknown) => typeof value === "string")
            : [];
        claims.set(address, {
            address,
            principal: String(entry?.principal ?? "0"),
            riskPayout: String(entry?.riskPayout ?? "0"),
            totalWithdraw: String(entry?.totalWithdraw ?? "0"),
            rewardAmount: String(entry?.rewardAmount ?? "0"),
            proof,
        });
    }
    return claims;
};
const safeBigInt = (value: unknown) => {
    try {
        return BigInt((value ?? "0") as string | number | bigint | boolean);
    }
    catch {
        return 0n;
    }
};
const getProtocolFeeBps = async () => {
    if (!isValcoreChainEnabled()) {
        const configuredFeeBps = Number(env.PROTOCOL_FEE_BPS);
        return Number.isFinite(configuredFeeBps)
            ? Math.max(0, Math.min(10000, Math.floor(configuredFeeBps)))
            : 0;
    }
    const configuredFeeBps = Number(env.PROTOCOL_FEE_BPS);
    let feeBps = Number.isFinite(configuredFeeBps)
        ? Math.max(0, Math.min(10_000, Math.floor(configuredFeeBps)))
        : 0;
    const leagueAddress = await resolveLeagueAddress();
    if (!leagueAddress)
        return feeBps;
    try {
        const onchainFee = await getOnchainFeeBps(leagueAddress);
        if (Number.isFinite(onchainFee) && onchainFee >= 0 && onchainFee <= 10_000) {
            feeBps = Math.floor(onchainFee);
        }
    }
    catch {
        // Fallback to env fee bps
    }
    return feeBps;
};
const getPositionStatesForWeek = async (weekId: string, addresses: string[]) => {
    if (!isValcoreChainEnabled()) {
        return new Map();
    }
    const normalized = Array.from(new Set(addresses
        .map((value: string) => normalizeAddressByChain(value))
        .filter((value): value is string => Boolean(value))));
    const states = new Map();
    if (!normalized.length)
        return states;
    const leagueAddress = await resolveLeagueAddress();
    if (!leagueAddress)
        return states;

    await Promise.all(normalized.map(async (address) => {
        try {
            const position = await getOnchainPosition(leagueAddress, BigInt(weekId), address);
            states.set(address, {
                claimed: Boolean(position.claimed),
                forfeitedRewardWei: position.forfeitedReward.toString(),
                riskWei: position.risk.toString(),
            });
        }
        catch {
            states.set(address, {
                claimed: null,
                forfeitedRewardWei: null,
                riskWei: null,
            });
        }
    }));

    return states;
};
const getClaimedFlagsForWeek = async (weekId: string, addresses: string[]) => {
    const flags = new Map();
    const states = await getPositionStatesForWeek(weekId, addresses);
    for (const [address, state] of states.entries()) {
        flags.set(address, state?.claimed ?? null);
    }
    return flags;
};
const buildLiveLeaderboardRows = async (weekId: string) => {
    const weekCoins = await getWeekCoins(weekId);
    const lineups = await getLineups(weekId);
    if (!weekCoins.length || !lineups.length) {
        return [];
    }
    const allCoins = await getCoins();
    const coinMap = new Map(allCoins.map((coin) => [coin.id, coin]));
    const weekCoinMap = new Map(weekCoins.map((row) => [row.coin_id, row]));
    const weeklyPrices = await getWeeklyCoinPrices(weekId);
    const startPriceBySymbol = new Map(weeklyPrices
        .filter((row) => row.start_price !== null)
        .map((row) => [row.symbol.toUpperCase(), Number(row.start_price)]));
    const universeSymbols = weekCoins
        .map((weekCoin) => coinMap.get(weekCoin.coin_id)?.symbol?.toUpperCase() ?? "")
        .filter(Boolean);
    const livePrices = universeSymbols.length ? await getLivePrices(universeSymbols) : {};
    const markPriceBySymbol = new Map(Object.entries(livePrices)
        .map(([symbol, value]) => [symbol.toUpperCase(), Number(value)])
        .filter(([, value]) => Number.isFinite(value as number) && (value as number) > 0) as [string, number][]);
    const benchmarkPnlPercent = computeBenchmarkPnlPercent(universeSymbols, startPriceBySymbol, markPriceBySymbol);
    const rows = [];
    for (const lineup of lineups) {
        const slots = parseLineupSlots(lineup.slots_json);
        if (!slots.length)
            continue;
        const lineupId = `${weekId}-${String(lineup.address ?? "").toLowerCase()}`;
        const lineupPositions = await getLineupPositions(lineupId);
        const score = calculateLineupWeekScore({
            slots,
            lineupPositions,
            coinById: coinMap,
            weekCoinById: weekCoinMap,
            startPriceBySymbol,
            markPriceBySymbol,
            benchmarkPnlPercent,
        });
        rows.push({
            week_id: weekId,
            lineup_id: lineupId,
            address: String(lineup.address ?? "").toLowerCase(),
            raw_performance: score.rawPerformance,
            efficiency_multiplier: score.efficiencyMultiplier,
            final_score: score.finalScore,
            reward_amount_wei: null,
            created_at: lineup.created_at,
            deposit_wei: lineup.deposit_wei ?? "0",
            principal_wei: lineup.principal_wei ?? "0",
            risk_wei: lineup.risk_wei ?? "0",
            swaps: Number(lineup.swaps ?? 0),
        });
    }
    rows.sort((a, b) => {
        if (b.final_score !== a.final_score)
            return b.final_score - a.final_score;
        return a.address.localeCompare(b.address);
    });
    return rows.map((row, index) => ({ ...row, rank: index + 1 }));
};
const hydrateLineupCoins = (slots: { slotId: string; coinId: string }[], coinById: Map<string, { symbol?: string; name?: string }>) => slots.map((slot) => {
    const coin = coinById.get(slot.coinId);
    return {
        slotId: slot.slotId,
        coinId: slot.coinId,
        symbol: coin?.symbol ?? slot.coinId,
        name: coin?.name ?? slot.coinId,
    };
});
const buildWeekFinancePayload = async (weekId: string) => {
    const week = await getWeekById(weekId);
    if (!week)
        return null;
    const allCoins = await getCoins();
    const coinById = new Map(allCoins.map((coin) => [coin.id, coin]));
    const lineups = await getLineups(weekId);
    const swapLogs = await getSwapLogByWeek(weekId);
    const swapsByLineup = new Map();
    for (const swap of swapLogs) {
        const lineupId = String(swap.lineup_id ?? "").toLowerCase();
        if (!swapsByLineup.has(lineupId)) {
            swapsByLineup.set(lineupId, []);
        }
        swapsByLineup.get(lineupId).push({
            txHash: swap.swap_tx_hash,
            removedSymbol: swap.removed_symbol,
            addedSymbol: swap.added_symbol,
            timestamp: Number(swap.swap_timestamp ?? 0),
            createdAt: swap.created_at,
        });
    }
    const parsedWeek = WeekRowSchema.parse(week);
    const feeBps = await getProtocolFeeBps();
    if (parsedWeek.status === "ACTIVE") {
        const liveRows = await buildLiveLeaderboardRows(weekId);
        const liveByAddress = new Map(liveRows.map((row) => [String(row.address).toLowerCase(), row]));
        const totalCommittedWei = lineups.reduce((sum, row) => sum + BigInt(row.deposit_wei ?? "0"), 0n);
        const losersRiskWei = lineups.reduce((sum, lineup) => {
            const live = liveByAddress.get(String(lineup.address ?? "").toLowerCase());
            if (!live || Number(live.final_score) >= 0)
                return sum;
            return sum + BigInt(lineup.risk_wei ?? "0");
        }, 0n);
        const estimatedFeeWei = (losersRiskWei * BigInt(feeBps)) / 10_000n;
        const players = lineups.map((lineup) => {
            const address = String(lineup.address ?? "").toLowerCase();
            const slots = parseLineupSlots(lineup.slots_json);
            const lineupId = `${weekId}-${address}`;
            const live = liveByAddress.get(address);
            return {
                address,
                depositWei: lineup.deposit_wei ?? "0",
                principalWei: lineup.principal_wei ?? "0",
                riskWei: lineup.risk_wei ?? "0",
                score: Number(live?.final_score ?? 0),
                rawPerformance: Number(live?.raw_performance ?? 0),
                multiplier: Number(live?.efficiency_multiplier ?? 1),
                rewardWei: "0",
                totalWithdrawWei: "0",
                claimState: "n/a",
                claimed: null,
                swaps: Number(lineup.swaps ?? 0),
                coins: hydrateLineupCoins(slots, coinById),
                swapLog: swapsByLineup.get(lineupId) ?? [],
            };
        }).sort((a, b) => b.score - a.score);
        return {
            mode: "week",
            week: {
                id: parsedWeek.id,
                status: parsedWeek.status,
                startAtUtc: parsedWeek.start_at,
                lockAtUtc: parsedWeek.lock_at,
                endAtUtc: parsedWeek.end_at,
            },
            summary: {
                totalCommittedWei: totalCommittedWei.toString(),
                lossesWei: losersRiskWei.toString(),
                feeBps,
                feeWei: estimatedFeeWei.toString(),
                claimedWei: "0",
                remainingWei: "0",
                claimableWei: "0",
                rewardSweepWindowOpen: false,
                rewardSweepAvailableAtUtc: null,
                expiredRewardWei: "0",
                expiredRewardPlayers: 0,
                asOf: new Date().toISOString(),
                isLive: true,
            },
            players,
        };
    }
    const leaderboardRows = await getLeaderboardRows(weekId);
    const rowByAddress = new Map(leaderboardRows.map((row) => [String(row.address ?? "").toLowerCase(), row]));
    const claimsByAddress = readClaimsForWeek(weekId);
    const metadata = readWeekJsonFile("metadata", weekId) ?? {};
    const positionStates = await getPositionStatesForWeek(weekId, lineups.map((lineup) => lineup.address));
    const claimedFlags = await getClaimedFlagsForWeek(weekId, lineups.map((lineup) => lineup.address));
    const finalizedAtMs = Date.parse(parsedWeek.finalized_at ?? parsedWeek.end_at ?? "");
    const rewardSweepAvailableAtMs = Number.isFinite(finalizedAtMs)
        ? finalizedAtMs + REWARD_SWEEP_DELAY_MS
        : NaN;
    const rewardSweepWindowOpen = Number.isFinite(rewardSweepAvailableAtMs) && Date.now() >= rewardSweepAvailableAtMs;
    let expiredRewardWei = 0n;
    let expiredRewardPlayers = 0;
    let claimedWei = 0n;
    let remainingWei = 0n;
    const players = lineups.map((lineup) => {
        const address = String(lineup.address ?? "").toLowerCase();
        const row = rowByAddress.get(address);
        const claim = claimsByAddress.get(address);
        const claimed = claimedFlags.has(address) ? claimedFlags.get(address) : null;
        const positionState = positionStates.get(address);
        const totalWithdrawWei = claim?.totalWithdraw ? BigInt(claim.totalWithdraw) : 0n;
        if (claim) {
            if (claimed === true) {
                claimedWei += totalWithdrawWei;
            }
            else {
                remainingWei += totalWithdrawWei;
            }
        }
        const claimPrincipalWei = safeBigInt(claim?.principal ?? lineup.principal_wei ?? "0");
        const positionRiskWei = safeBigInt(positionState?.riskWei ?? lineup.risk_wei ?? "0");
        const derivedRewardWei = claim
            ? (() => {
                const baselineWei = claimPrincipalWei + positionRiskWei;
                return totalWithdrawWei > baselineWei ? totalWithdrawWei - baselineWei : 0n;
            })()
            : 0n;
        const forfeitedRewardWei = safeBigInt(positionState?.forfeitedRewardWei ?? "0");
        const isExpiredRewardClaim = rewardSweepWindowOpen &&
            claim &&
            claimed !== true &&
            forfeitedRewardWei === 0n &&
            derivedRewardWei > 0n;
        if (isExpiredRewardClaim) {
            expiredRewardWei += derivedRewardWei;
            expiredRewardPlayers += 1;
        }
        const slots = parseLineupSlots(lineup.slots_json);
        const lineupId = `${weekId}-${address}`;
        return {
            address,
            depositWei: lineup.deposit_wei ?? "0",
            principalWei: lineup.principal_wei ?? "0",
            riskWei: lineup.risk_wei ?? "0",
            score: Number(row?.final_score ?? 0),
            rawPerformance: Number(row?.raw_performance ?? 0),
            multiplier: Number(row?.efficiency_multiplier ?? 1),
            rewardWei: claim?.rewardAmount ?? row?.reward_amount_wei ?? "0",
            totalWithdrawWei: claim?.totalWithdraw ?? "0",
            claimState: claim
                ? claimed === true
                    ? "claimed"
                    : claimed === false
                        ? "unclaimed"
                        : "unknown"
                : "n/a",
            claimed,
            forfeitedRewardWei: forfeitedRewardWei.toString(),
            derivedRewardWei: derivedRewardWei.toString(),
            expiredRewardClaimable: Boolean(isExpiredRewardClaim),
            swaps: Number(lineup.swaps ?? 0),
            coins: hydrateLineupCoins(slots, coinById),
            swapLog: swapsByLineup.get(lineupId) ?? [],
        };
    }).sort((a, b) => b.score - a.score);
    const totalCommittedWei = lineups.reduce((sum, row) => sum + BigInt(row.deposit_wei ?? "0"), 0n);
    const lossesWei = metadata?.losersRiskTotalWei
        ? BigInt(metadata.losersRiskTotalWei)
        : lineups.reduce((sum, lineup) => {
            const score = Number(rowByAddress.get(String(lineup.address ?? "").toLowerCase())?.final_score ?? 0);
            if (score >= 0)
                return sum;
            return sum + BigInt(lineup.risk_wei ?? "0");
        }, 0n);
    const feeWei = metadata?.retainedFeeWei
        ? BigInt(metadata.retainedFeeWei)
        : (lossesWei * BigInt(feeBps)) / 10_000n;
    return {
        mode: "week",
        week: {
            id: parsedWeek.id,
            status: parsedWeek.status,
            startAtUtc: parsedWeek.start_at,
            lockAtUtc: parsedWeek.lock_at,
            endAtUtc: parsedWeek.end_at,
        },
        summary: {
            totalCommittedWei: totalCommittedWei.toString(),
            lossesWei: lossesWei.toString(),
            feeBps,
            feeWei: feeWei.toString(),
            claimedWei: claimedWei.toString(),
            remainingWei: remainingWei.toString(),
            claimableWei: (claimedWei + remainingWei).toString(),
            rewardSweepWindowOpen,
            rewardSweepAvailableAtUtc: Number.isFinite(rewardSweepAvailableAtMs)
                ? new Date(rewardSweepAvailableAtMs).toISOString()
                : null,
            expiredRewardWei: expiredRewardWei.toString(),
            expiredRewardPlayers,
            asOf: new Date().toISOString(),
            isLive: false,
        },
        players,
    };
};
const sweepExpiredRewardsForWeek = async (weekId: string) => {
    if (!isValcoreChainEnabled()) {
        throw new Error("Reward sweep is disabled while ORACLE_VALCORE_CHAIN_ENABLED is off");
    }
    const chainConfig = await getRuntimeChainConfig();
    if (String(chainConfig.chainType ?? "evm").toLowerCase() !== "evm") {
        throw new Error("Reward sweep is currently supported only for EVM chains");
    }
    const week = await getWeekById(weekId);
    if (!week) {
        throw new Error("Week not found");
    }
    const parsedWeek = WeekRowSchema.parse(week);
    if (String(parsedWeek.status ?? "").toUpperCase() !== "FINALIZED") {
        throw new Error("Week must be FINALIZED");
    }
    const finalizedAtMs = Date.parse(parsedWeek.finalized_at ?? parsedWeek.end_at ?? "");
    if (!Number.isFinite(finalizedAtMs)) {
        throw new Error("Finalized timestamp missing");
    }
    if (Date.now() < finalizedAtMs + REWARD_SWEEP_DELAY_MS) {
        throw new Error("Reward sweep window is not open yet");
    }
    const leagueAddress = await resolveLeagueAddress();
    if (!leagueAddress) {
        throw new Error("League contract address is not configured");
    }
    const oraclePrivateKey = await getRequiredRuntimeOraclePrivateKey();
    const claimsByAddress = readClaimsForWeek(weekId);
    const lineups = await getLineups(weekId);
    const positionStates = await getPositionStatesForWeek(weekId, lineups.map((row) => row.address));
    const provider = await getRuntimeProvider();
    const wallet = new ethers.Wallet(oraclePrivateKey, provider);
    const league = new ethers.Contract(leagueAddress, [
        "function sweepExpiredReward(uint256 weekId,address user,uint256 principal,uint256 riskPayout,uint256 totalWithdraw,bytes32[] proof)",
    ], wallet);
    let eligiblePlayers = 0;
    let sweptPlayers = 0;
    let skippedPlayers = 0;
    let failedPlayers = 0;
    let sweptWei = 0n;
    const txHashes = [];
    const errors = [];
    for (const lineup of lineups) {
        const address = String(lineup.address ?? "").toLowerCase();
        const claim = claimsByAddress.get(address);
        if (!claim) {
            skippedPlayers += 1;
            continue;
        }
        const state = positionStates.get(address);
        if (state?.claimed === true) {
            skippedPlayers += 1;
            continue;
        }
        const forfeitedRewardWei = safeBigInt(state?.forfeitedRewardWei ?? "0");
        if (forfeitedRewardWei > 0n) {
            skippedPlayers += 1;
            continue;
        }
        const principalWei = safeBigInt(claim.principal);
        const riskWei = safeBigInt(state?.riskWei ?? lineup.risk_wei ?? "0");
        const totalWithdrawWei = safeBigInt(claim.totalWithdraw);
        const baselineWei = principalWei + riskWei;
        const rewardWei = totalWithdrawWei > baselineWei ? totalWithdrawWei - baselineWei : 0n;
        if (rewardWei <= 0n) {
            skippedPlayers += 1;
            continue;
        }
        if (!claim.proof.length) {
            failedPlayers += 1;
            errors.push({ address, error: "Missing proof" });
            continue;
        }
        eligiblePlayers += 1;
        try {
            const sent = await sendTxWithPolicy({
                label: `sweepExpiredReward(${weekId}:${address})`,
                signer: wallet,
                send: (overrides) => league.sweepExpiredReward(BigInt(weekId), address, principalWei, safeBigInt(claim.riskPayout), totalWithdrawWei, claim.proof, overrides),
            });
            sweptPlayers += 1;
            sweptWei += rewardWei;
            txHashes.push(sent.txHash);
        }
        catch (error) {
            failedPlayers += 1;
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ address, error: message.slice(0, 240) });
        }
    }
    return {
        weekId,
        eligiblePlayers,
        sweptPlayers,
        skippedPlayers,
        failedPlayers,
        sweptWei: sweptWei.toString(),
        txHashes: txHashes.slice(0, 20),
        errors: errors.slice(0, 20),
    };
};
const buildAllTimeFinancePayload = async () => {
    const weeks = await getWeeks();
    const weekById = new Map(weeks.map((week) => [String(week.id), WeekRowSchema.parse(week)]));
    const allCoins = await getCoins();
    const coinById = new Map(allCoins.map((coin) => [coin.id, coin]));
    const allLineups = await getAllLineups();
    const allResults = await getAllWeeklyResults();
    const resultByKey = new Map(allResults.map((row) => [`${row.week_id}:${String(row.address).toLowerCase()}`, row]));
    const feeBps = await getProtocolFeeBps();
    const lineupsByWeek = new Map();
    for (const lineup of allLineups) {
        const weekId = String(lineup.week_id);
        if (!lineupsByWeek.has(weekId)) {
            lineupsByWeek.set(weekId, []);
        }
        lineupsByWeek.get(weekId).push(lineup);
    }
    const claimsByWeek = new Map();
    const claimedFlagsByWeek = new Map();
    let totalFeeWei = 0n;
    for (const week of weeks) {
        if (week.status !== "FINALIZED")
            continue;
        const weekId = String(week.id);
        const claimsRaw = readWeekJsonFile("claims", weekId) ?? [];
        const claimsMap = new Map();
        for (const claim of claimsRaw) {
            const address = String(claim.address ?? "").toLowerCase();
            if (!address)
                continue;
            claimsMap.set(address, claim);
        }
        claimsByWeek.set(weekId, claimsMap);
        const lineupsForWeek = lineupsByWeek.get(weekId) ?? [];
        const flags = await getClaimedFlagsForWeek(weekId, lineupsForWeek.map((lineup: { address: string }) => lineup.address));
        claimedFlagsByWeek.set(weekId, flags);
        const metadata = readWeekJsonFile("metadata", weekId);
        if (metadata?.retainedFeeWei) {
            totalFeeWei += BigInt(metadata.retainedFeeWei);
            continue;
        }
        const lossesWei = lineupsForWeek.reduce((sum: bigint, lineup: { address: string; risk_wei?: string }) => {
            const score = Number(resultByKey.get(`${weekId}:${String(lineup.address ?? "").toLowerCase()}`)?.final_score ?? 0);
            if (score >= 0)
                return sum;
            return sum + BigInt(lineup.risk_wei ?? "0");
        }, 0n);
        totalFeeWei += (lossesWei * BigInt(feeBps)) / 10_000n;
    }
    const playerMap = new Map();
    let totalCommittedWei = 0n;
    let totalClaimedWei = 0n;
    let totalRemainingWei = 0n;
    for (const lineup of allLineups) {
        const weekId = String(lineup.week_id);
        const address = String(lineup.address ?? "").toLowerCase();
        const week = weekById.get(weekId);
        const key = `${weekId}:${address}`;
        const result = resultByKey.get(key);
        const claimsMap = claimsByWeek.get(weekId);
        const claim = claimsMap?.get(address);
        const claimedFlag = claimedFlagsByWeek.get(weekId)?.get(address);
        const depositWei = BigInt(lineup.deposit_wei ?? "0");
        totalCommittedWei += depositWei;
        const totalWithdrawWei = claim?.totalWithdraw ? BigInt(claim.totalWithdraw) : 0n;
        let claimedWei = 0n;
        let remainingWei = 0n;
        let claimState = "n/a";
        if (claim) {
            if (claimedFlag === true) {
                claimedWei = totalWithdrawWei;
                claimState = "claimed";
            }
            else if (claimedFlag === false) {
                remainingWei = totalWithdrawWei;
                claimState = "unclaimed";
            }
            else {
                remainingWei = totalWithdrawWei;
                claimState = "unknown";
            }
        }
        totalClaimedWei += claimedWei;
        totalRemainingWei += remainingWei;
        const pnlWei = totalWithdrawWei > 0n ? totalWithdrawWei - depositWei : 0n;
        const wonWei = pnlWei > 0n ? pnlWei : 0n;
        const lostWei = pnlWei < 0n ? -pnlWei : 0n;
        const slots = parseLineupSlots(lineup.slots_json);
        const weekEntry = {
            weekId,
            weekStartAtUtc: week?.start_at ?? null,
            weekStatus: week?.status ?? "UNKNOWN",
            depositWei: depositWei.toString(),
            wonWei: wonWei.toString(),
            lostWei: lostWei.toString(),
            claimState,
            claimedWei: claimedWei.toString(),
            remainingWei: remainingWei.toString(),
            swaps: Number(lineup.swaps ?? 0),
            score: Number(result?.final_score ?? 0),
            coins: hydrateLineupCoins(slots, coinById),
        };
        const existing = playerMap.get(address) ?? {
            address,
            weeksPlayed: 0,
            wins: 0,
            losses: 0,
            totalCommittedWei: 0n,
            totalClaimedWei: 0n,
            totalRemainingWei: 0n,
            weeks: [],
        };
        existing.weeksPlayed += 1;
        existing.totalCommittedWei += depositWei;
        existing.totalClaimedWei += claimedWei;
        existing.totalRemainingWei += remainingWei;
        const score = Number(result?.final_score ?? 0);
        if (score > 0)
            existing.wins += 1;
        if (score < 0)
            existing.losses += 1;
        existing.weeks.push(weekEntry);
        playerMap.set(address, existing);
    }
    const players = Array.from(playerMap.values())
        .map((player) => ({
        address: player.address,
        weeksPlayed: player.weeksPlayed,
        wins: player.wins,
        losses: player.losses,
        totalCommittedWei: player.totalCommittedWei.toString(),
        totalClaimedWei: player.totalClaimedWei.toString(),
        totalRemainingWei: player.totalRemainingWei.toString(),
        weeks: player.weeks.sort((a: { weekStartAtUtc?: string | null }, b: { weekStartAtUtc?: string | null }) => String(b.weekStartAtUtc ?? "").localeCompare(String(a.weekStartAtUtc ?? ""))),
    }))
        .sort((a, b) => {
        const aValue = BigInt(a.totalClaimedWei) + BigInt(a.totalRemainingWei);
        const bValue = BigInt(b.totalClaimedWei) + BigInt(b.totalRemainingWei);
        if (aValue !== bValue)
            return aValue > bValue ? -1 : 1;
        return a.address.localeCompare(b.address);
    });
    return {
        mode: "all-time",
        summary: {
            totalCommittedWei: totalCommittedWei.toString(),
            totalFeeWei: totalFeeWei.toString(),
            totalClaimedWei: totalClaimedWei.toString(),
            totalRemainingWei: (totalCommittedWei - totalClaimedWei).toString(),
            players: players.length,
            weeks: Array.from(new Set(allLineups.map((row) => row.week_id))).length,
            asOf: new Date().toISOString(),
        },
        players,
    };
};

const sendSse = (client: { reply: { raw: { write: (data: string) => void } } }, event: string, payload: unknown) => {
    try {
        const data = JSON.stringify(payload);
        client.reply.raw.write(`event: ${event}\n`);
        client.reply.raw.write(`data: ${data}\n\n`);
    } catch {
        // client disconnected - will be cleaned up on 'close' event
    }
};
const broadcastSse = (event: string, payload: unknown) => {
    for (const client of sseClients.values()) {
        sendSse(client, event, payload);
    }
};
let lastWeekSignature = "";
let rewardSweepInProgress = false;
server.get("/health", async () => ({ ok: true }));
server.get("/runtime/profile", async () => {
    const chainConfig = await getRuntimeChainConfig();
    return {
        networkKey: chainConfig.networkKey,
        label: chainConfig.label,
        chainType: chainConfig.chainType,
        chainId: chainConfig.chainId,
        rpcUrl: chainConfig.rpcUrl,
        explorerUrl: chainConfig.explorerUrl,
        nativeSymbol: chainConfig.nativeSymbol,
        nativeTokenAddress: chainConfig.nativeTokenAddress,
        stablecoin: {
            symbol: chainConfig.stablecoinSymbol,
            name: chainConfig.stablecoinName,
            decimals: chainConfig.stablecoinDecimals,
            address: chainConfig.stablecoinAddress,
        },
        contracts: {
            leagueAddress: chainConfig.valcoreAddress,
            stablecoinAddress: chainConfig.stablecoinAddress,
        },
    };
});

server.get("/weeks", async (request) => {
    const query = z
        .object({
        limit: z.coerce.number().int().min(1).max(104).optional(),
    })
        .parse(request.query ?? {});

    const weeks = filterPublicWeeks(await getWeeks());
    const limited = weeks.slice(0, query.limit ?? 24);

    return limited.map((row: unknown) => buildPublicWeekPayload(WeekRowSchema.parse(row)));
});
server.get("/events", async (request, reply) => {
    const requestOrigin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (requestOrigin && !isOriginAllowed(requestOrigin)) {
        return reply.code(403).send({ error: "Origin not allowed" });
    }
    if (sseClients.size >= MAX_SSE_CLIENTS) {
        return reply.code(503).send({ error: "SSE capacity reached" });
    }
    const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(requestOrigin ? { "Access-Control-Allow-Origin": requestOrigin, Vary: "Origin" } : {}),
    };
    reply.raw.writeHead(200, headers);
    reply.raw.write("retry: 3000\n\n");
    reply.hijack();
    const clientId = sseClientId += 1;
    const pingTimer = setInterval(() => {
        try {
            reply.raw.write(`event: ping\ndata: ${Date.now()}\n\n`);
        } catch {
            // client disconnected
        }
    }, 25000) as unknown as NodeJS.Timeout;
    const client = { id: clientId, reply, pingTimer };
    sseClients.set(clientId, client);
    const snapshot = await buildWeekSnapshot();
    sendSse(client, "week", snapshot);
    lastWeekSignature = snapshotSignature(snapshot);
    request.raw.on("close", () => {
        clearInterval(pingTimer);
        sseClients.delete(clientId);
    });
});
server.get("/weeks/current", async () => {
    const weeks = await getWeeks(); // Already sorted by start_at DESC
    const row = getCurrentPublicWeek(weeks);
    if (!row)
        return null;
    const parsed = WeekRowSchema.parse(row);
    return buildPublicWeekPayload(parsed);
});
server.get("/weeks/:weekId/reactive-flow", async (request) => {
    const params = z.object({ weekId: z.string() }).parse(request.params);
    const query = z
        .object({ limit: z.coerce.number().int().min(1).max(50).optional() })
        .parse(request.query ?? {});
    const requestedLimit = query.limit ?? 50;
    const weekRows = await listLifecycleReactiveEvents({
        weekId: params.weekId,
        limit: requestedLimit,
    });
    let rows = weekRows;
    if (weekRows.length < requestedLimit) {
        const globalRows = await listLifecycleReactiveEvents({
            weekId: null,
            limit: requestedLimit,
        });
        const deduped = new Map<string, any>();
        for (const row of [...weekRows, ...globalRows]) {
            deduped.set(String(row?.id ?? ""), row);
            if (deduped.size >= requestedLimit)
                break;
        }
        rows = Array.from(deduped.values());
    }
    const reactiveExplorerBase = "https://lasna.reactscan.net";
    const chainExplorerBase = String(env.CHAIN_EXPLORER_URL ?? "").trim().replace(/\/+$/u, "");
    const destinationReceiverAddress = normalizeMaybeAddress(env.REACTIVE_RECEIVER_ADDRESS);
    const destinationProvider = destinationReceiverAddress ? await getRuntimeProvider() : null;
    const destinationTopic0 = ethers.id("ReactiveLifecycleExecuted(bytes32,uint8,uint256)");
    const destinationLookupCache = new Map<string, Promise<string | null>>();
    const normalizeHash = (value: unknown) => {
        const hash = String(value ?? "").trim().toLowerCase();
        return /^0x[0-9a-f]{64}$/u.test(hash) ? hash : null;
    };
    const resolveDestinationTxHashByOpKey = async (opKeyRaw: unknown) => {
        const opKey = String(opKeyRaw ?? "").trim();
        if (!opKey || !destinationProvider || !destinationReceiverAddress)
            return null;
        if (destinationLookupCache.has(opKey)) {
            return destinationLookupCache.get(opKey) as Promise<string | null>;
        }
        const task = (async () => {
            try {
                const latest = await destinationProvider.getBlockNumber();
                const fromBlock = Math.max(0, latest - 2_000_000);
                const intentIds = [ethers.id(opKey).toLowerCase(), ethers.id(`valcore:lifecycle:${opKey}`).toLowerCase()];
                for (const intentId of intentIds) {
                    const logs = await destinationProvider.getLogs({
                        address: destinationReceiverAddress,
                        fromBlock,
                        toBlock: latest,
                        topics: [destinationTopic0, intentId],
                    });
                    const hit = normalizeHash(logs[logs.length - 1]?.transactionHash);
                    if (hit)
                        return hit;
                }
                return null;
            }
            catch {
                return null;
            }
        })();
        destinationLookupCache.set(opKey, task);
        return task;
    };
    const events = await Promise.all(rows.map(async (row: any) => {
        const reactiveTxHash =
            typeof row?.reactive_tx_hash === "string" && row.reactive_tx_hash.trim()
                ? row.reactive_tx_hash.trim().toLowerCase()
                : null;
        let sepoliaTxHash =
            typeof row?.destination_tx_hash === "string" && row.destination_tx_hash.trim()
                ? row.destination_tx_hash.trim().toLowerCase()
                : null;
        if (!sepoliaTxHash) {
            sepoliaTxHash = await resolveDestinationTxHashByOpKey(row?.op_key);
        }
        const normalizedReactive = normalizeHash(reactiveTxHash);
        const normalizedSepolia = normalizeHash(sepoliaTxHash);
        return {
            id: String(row?.id ?? ""),
            opKey: String(row?.op_key ?? ""),
            weekId: String(row?.week_id ?? params.weekId),
            operation: String(row?.operation ?? ""),
            status: String(row?.status ?? ""),
            reactiveTxHash: normalizedReactive,
            reactiveTxUrl: normalizedReactive ? reactiveExplorerBase + "/tx/" + normalizedReactive : null,
            sepoliaTxHash: normalizedSepolia,
            sepoliaTxUrl: normalizedSepolia && chainExplorerBase ? chainExplorerBase + "/tx/" + normalizedSepolia : null,
            createdAt: String(row?.created_at ?? ""),
            updatedAt: String(row?.updated_at ?? ""),
        };
    }));
    return {
        weekId: params.weekId,
        events,
    };
});
const classifyReactiveTargetContract = (input: {
    toAddress: string | null;
    dispatcherAddress: string | null;
    callbackSenderAddress: string | null;
}) => {
    const toAddress = String(input.toAddress ?? "").toLowerCase();
    const dispatcher = String(input.dispatcherAddress ?? "").toLowerCase();
    const callbackSender = String(input.callbackSenderAddress ?? "").toLowerCase();
    if (toAddress && dispatcher && toAddress === dispatcher) {
        return "ValcoreReactiveDispatcher";
    }
    if (toAddress && callbackSender && toAddress === callbackSender) {
        return "ReactiveCallbackSender";
    }
    return toAddress ? "UnknownReactiveContract" : null;
};
server.get("/admin/reactive-txs", async (request) => {
    const query = z
        .object({
        weekId: z.string().trim().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
    })
        .parse(request.query ?? {});
    const events = await listLifecycleReactiveEvents({
        weekId: query.weekId ?? null,
        limit: query.limit ?? 60,
    });
    const explorerBase = "https://lasna.reactscan.net";
    const rpcUrl = String(env.REACTIVE_CHAIN_RPC_URL ?? "").trim();
    const chainIdRaw = Number(env.REACTIVE_CHAIN_ID);
    const chainId = Number.isFinite(chainIdRaw) && chainIdRaw > 0 ? Math.floor(chainIdRaw) : null;
    const dispatcherAddress = normalizeMaybeAddress(env.REACTIVE_DISPATCHER_ADDRESS);
    const callbackSenderAddress = normalizeMaybeAddress(env.REACTIVE_CALLBACK_SENDER_ADDRESS);
    const provider = rpcUrl ? new ethers.JsonRpcProvider(rpcUrl, chainId ?? 5318007) : null;
    const hydrated = await Promise.all(events.map(async (row: any) => {
        const reactiveTxHash = typeof row?.reactive_tx_hash === "string" && row.reactive_tx_hash.trim()
            ? row.reactive_tx_hash.trim().toLowerCase()
            : null;
        let reactiveTx: {
            found: boolean;
            from: string | null;
            to: string | null;
            blockNumber: number | null;
            status: number | null;
            methodSelector: string | null;
            targetContractAddress: string | null;
            targetContractLabel: string | null;
            logAddress: string | null;
            error: string | null;
        } | null = null;
        if (reactiveTxHash) {
            if (!provider) {
                reactiveTx = {
                    found: false,
                    from: null,
                    to: null,
                    blockNumber: null,
                    status: null,
                    methodSelector: null,
                    targetContractAddress: null,
                    targetContractLabel: null,
                    logAddress: null,
                    error: "Reactive RPC is not configured",
                };
            }
            else {
                try {
                    const [tx, receipt] = await Promise.all([
                        provider.getTransaction(reactiveTxHash),
                        provider.getTransactionReceipt(reactiveTxHash),
                    ]);
                    const toAddress = tx?.to ? normalizeMaybeAddress(tx.to) : null;
                    const firstLogAddress = receipt?.logs?.[0]?.address
                        ? normalizeMaybeAddress(receipt.logs[0].address)
                        : null;
                    reactiveTx = {
                        found: Boolean(tx),
                        from: tx?.from ? normalizeMaybeAddress(tx.from) : null,
                        to: toAddress,
                        blockNumber: tx?.blockNumber ?? null,
                        status: typeof receipt?.status === "number" ? receipt.status : null,
                        methodSelector: tx?.data ? String(tx.data).slice(0, 10).toLowerCase() : null,
                        targetContractAddress: toAddress,
                        targetContractLabel: classifyReactiveTargetContract({
                            toAddress,
                            dispatcherAddress,
                            callbackSenderAddress,
                        }),
                        logAddress: firstLogAddress,
                        error: tx ? null : "Reactive transaction not found",
                    };
                }
                catch (error) {
                    reactiveTx = {
                        found: false,
                        from: null,
                        to: null,
                        blockNumber: null,
                        status: null,
                        methodSelector: null,
                        targetContractAddress: null,
                        targetContractLabel: null,
                        logAddress: null,
                        error: error instanceof Error ? error.message : "Reactive transaction lookup failed",
                    };
                }
            }
        }
        return {
            id: String(row?.id ?? ""),
            opKey: String(row?.op_key ?? ""),
            weekId: String(row?.week_id ?? ""),
            operation: String(row?.operation ?? ""),
            status: String(row?.status ?? ""),
            reactiveTxHash,
            reactiveTxUrl: reactiveTxHash ? `${explorerBase}/tx/${reactiveTxHash}` : null,
            createdAt: String(row?.created_at ?? ""),
            updatedAt: String(row?.updated_at ?? ""),
            reactiveTx,
        };
    }));
    return {
        network: {
            chainId,
            rpcConfigured: Boolean(rpcUrl),
            explorerBase,
            dispatcherAddress,
            callbackSenderAddress,
        },
        events: hydrated,
    };
});
server.get("/weeks/:weekId/coins", async (request) => {
    const params = z.object({ weekId: z.string() }).parse(request.params);
    // Optimized: Single JOIN query would be better, but keeping simple for now
    const weekCoins = await getWeekCoins(params.weekId); // Already sorted by rank
    const allCoins = await getCoins();
    const coinMap = new Map(allCoins.map(c => [c.id, c]));
    const weeklyPrices = await getWeeklyCoinPrices(params.weekId);
    const startPriceBySymbol = new Map(weeklyPrices.map((row) => [row.symbol.toUpperCase(), row.start_price]));
    return weekCoins.map((row) => {
        const coin = coinMap.get(row.coin_id);
        const symbol = coin?.symbol ? coin.symbol.toUpperCase() : null;
        const snapshotPrice = symbol ? startPriceBySymbol.get(symbol) ?? null : null;
        return {
            id: `${row.week_id}-${row.coin_id}`,
            weekId: row.week_id,
            coinId: row.coin_id,
            rank: row.rank,
            position: row.position,
            salary: row.salary,
            snapshotPrice,
            power: row.power,
            risk: row.risk,
            momentum: row.momentum,
            momentumLive: row.momentum_live ?? null,
            metricsUpdatedAt: row.metrics_updated_at ?? null,
            coin: {
                symbol: coin?.symbol ?? "",
                name: coin?.name ?? "",
                isStable: coin?.category_id === "stablecoin",
                imagePath: coin?.image_path ?? null,
            },
        };
    });
});
server.get("/weeks/:weekId/showcase-lineup", async (request, reply) => {
    const params = z.object({ weekId: z.string() }).parse(request.params);
    const cached = await getWeekShowcaseLineup(params.weekId);
    const cachedPayload = getShowcaseFromCache(cached);
    if (cachedPayload) {
        return cachedPayload;
    }
    const generated = await buildShowcaseLineup(params.weekId);
    if (!generated) {
        return reply.code(404).send({ error: "Showcase lineup unavailable" });
    }
    return generated;
});
server.get("/weeks/:weekId/lineups/:address", async (request, reply) => {
    const params = z
        .object({ weekId: z.string(), address: z.string() })
        .parse(request.params);
    const address = params.address.trim().toLowerCase();
    const lineup = await getLineupByAddress(params.weekId, address);
    if (!lineup) {
        return reply.code(404).send({ error: "Lineup not found" });
    }
    let slotsRaw;
    try {
        slotsRaw = JSON.parse(lineup.slots_json);
    }
    catch {
        return reply.code(400).send({ error: "Invalid lineup slots" });
    }
    const slotsParsed = z
        .array(z.object({ slotId: z.string(), coinId: z.string() }))
        .safeParse(slotsRaw);
    if (!slotsParsed.success) {
        return reply.code(400).send({ error: "Invalid lineup slots" });
    }
    return {
        ok: true,
        weekId: lineup.week_id,
        address: lineup.address,
        lineupHash: lineup.lineup_hash,
        depositWei: lineup.deposit_wei,
        principalWei: lineup.principal_wei,
        riskWei: lineup.risk_wei,
        swaps: lineup.swaps,
        createdAt: lineup.created_at,
        slots: slotsParsed.data,
    };
});
server.get("/weeks/:weekId/lineups/:address/score", async (request, reply) => {
    const params = z
        .object({ weekId: z.string(), address: z.string() })
        .parse(request.params);
    const address = params.address.trim().toLowerCase();
    const lineup = await getLineupByAddress(params.weekId, address);
    if (!lineup) {
        return reply.code(404).send({ error: "Lineup not found" });
    }
    let slotsRaw;
    try {
        slotsRaw = JSON.parse(lineup.slots_json);
    }
    catch {
        return reply.code(400).send({ error: "Invalid lineup slots" });
    }
    const slotsParsed = z
        .array(z.object({ slotId: z.string(), coinId: z.string() }))
        .safeParse(slotsRaw);
    if (!slotsParsed.success) {
        return reply.code(400).send({ error: "Invalid lineup slots" });
    }
    const weekCoins = await getWeekCoins(params.weekId);
    if (!weekCoins.length) {
        return reply.code(404).send({ error: "Week coins missing" });
    }
    const allCoins = await getCoins();
    const coinMap = new Map(allCoins.map((coin) => [coin.id, coin]));
    const weekCoinMap = new Map(weekCoins.map((row) => [row.coin_id, row]));
    const weeklyPrices = await getWeeklyCoinPrices(params.weekId);
    const startPriceBySymbol = new Map(weeklyPrices
        .filter((row) => row.start_price !== null)
        .map((row) => [row.symbol.toUpperCase(), Number(row.start_price)]));
    const universeSymbols = weekCoins
        .map((weekCoin) => coinMap.get(weekCoin.coin_id)?.symbol?.toUpperCase() ?? "")
        .filter(Boolean);
    const lineupId = `${params.weekId}-${address}`;
    const lineupPositions = await getLineupPositions(lineupId);
    const symbolsForLivePrices = new Set(universeSymbols);
    for (const position of lineupPositions) {
        if (position.symbol) {
            symbolsForLivePrices.add(position.symbol.toUpperCase());
        }
    }
    for (const slot of slotsParsed.data) {
        const coin = coinMap.get(slot.coinId);
        if (coin?.symbol) {
            symbolsForLivePrices.add(coin.symbol.toUpperCase());
        }
    }
    const livePrices = symbolsForLivePrices.size
        ? await getLivePrices(Array.from(symbolsForLivePrices))
        : {};
    const markPriceBySymbol = new Map(Object.entries(livePrices)
        .map(([symbol, value]) => [symbol.toUpperCase(), Number(value)])
        .filter(([, value]) => Number.isFinite(value as number) && (value as number) > 0) as [string, number][]);
    const benchmarkPnlPercent = computeBenchmarkPnlPercent(universeSymbols, startPriceBySymbol, markPriceBySymbol);
    const score = calculateLineupWeekScore({
        slots: slotsParsed.data,
        lineupPositions,
        coinById: coinMap,
        weekCoinById: weekCoinMap,
        startPriceBySymbol,
        markPriceBySymbol,
        benchmarkPnlPercent,
    });
    return {
        ok: true,
        weekId: params.weekId,
        address,
        score: {
            rawPerformance: score.rawPerformance,
            efficiencyMultiplier: score.efficiencyMultiplier,
            finalScore: score.finalScore,
            totalSalaryUsed: score.totalSalaryUsed,
            positions: score.positions,
            benchmarkPnlPercent: score.benchmarkPnlPercent,
            lineupPnlPercent: score.lineupPnlPercent,
            lineupAlphaPercent: score.lineupAlphaPercent,
        },
        pricesAsOf: new Date().toISOString(),
    };
});
server.get("/weeks/:weekId/claims/:address", async (request, reply) => {
    const params = z
        .object({ weekId: z.string(), address: z.string() })
        .parse(request.params);
    const claimsUnlocked = await areClaimsUnlockedForWeek(params.weekId);
    if (!claimsUnlocked) {
        return reply.code(423).send({
            error: "Settlement pending",
            message: "Claims unlock after the next run week is created.",
        });
    }
    const fileName = `claims-${params.weekId}.json`;
    const candidates = [
        resolve(resolveDataDir(), fileName),
        resolve(process.cwd(), "apps", "oracle", "data", fileName),
        resolve(process.cwd(), "data", fileName),
    ];
    const path = candidates.find((candidate) => existsSync(candidate));
    try {
        if (!path)
            return reply.code(404).send({ error: "Claims file missing" });
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        const claim = raw.find((entry: { address: string }) => entry.address.toLowerCase() === params.address.toLowerCase());
        if (!claim)
            return reply.code(404).send({ error: "Claim not found" });
        return claim;
    }
    catch (error) {
        return reply.code(404).send({ error: "Claims file missing" });
    }
});
server.get("/weeks/:weekId/refunds/:address", async (request, reply) => {
    const params = z
        .object({ weekId: z.string(), address: z.string() })
        .parse(request.params);
    const fileName = `refund-claims-${params.weekId}.json`;
    const candidates = [
        resolve(resolveDataDir(), fileName),
        resolve(process.cwd(), "apps", "oracle", "data", fileName),
        resolve(process.cwd(), "data", fileName),
    ];
    const path = candidates.find((candidate) => existsSync(candidate));
    try {
        if (!path)
            return reply.code(404).send({ error: "Refund file missing" });
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        const claim = raw.find((entry: { address: string }) => entry.address.toLowerCase() === params.address.toLowerCase());
        if (!claim)
            return reply.code(404).send({ error: "Refund not found" });
        return claim;
    }
    catch {
        return reply.code(404).send({ error: "Refund file missing" });
    }
});
const LineupSlotsSchema = z.array(z.object({
    slotId: z.string().min(1),
    coinId: z.string().min(1),
})).min(11).max(11);
const LineupSwapSchema = z.object({
    slotId: z.string().min(1),
    removedSymbol: z.string().min(1),
    addedSymbol: z.string().min(1),
}).strict();
const LineupIntentPrepareSchema = z.object({
    weekId: z.string().min(1),
    address: z.string(),
    source: z.enum(["commit", "swap"]),
    slots: LineupSlotsSchema,
    swap: LineupSwapSchema.optional(),
}).strict();
const LineupIntentSubmitSchema = z.object({
    address: z.string(),
    txHash: z.string().regex(/^0x[a-fA-F0-9]{1,64}$/),
}).strict();
const LineupIntentCancelSchema = z.object({
    address: z.string(),
    reason: z.string().min(1).max(240).optional(),
}).strict();
const LineupSyncSchema = z.object({
    txHash: z.string().regex(/^0x[a-fA-F0-9]{1,64}$/),
    weekId: z.string().optional(),
    addressHint: z.string().optional(),
    source: z.enum(["commit", "swap"]).optional(),
    slots: LineupSlotsSchema,
    swap: LineupSwapSchema.optional(),
}).strict();
const StrategistProfileNonceSchema = z.object({
    address: z.string(),
}).strict();
const StrategistProfileUpsertSchema = z.object({
    address: z.string(),
    displayName: z.string(),
    nonce: z.string().optional(),
    signature: z.union([z.string(), z.array(z.string())]).optional(),
}).strict();
const normalizePlayerDisplayName = (value: unknown) => {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{1,22}[A-Za-z0-9])$/.test(normalized)) {
        return null;
    }
    return normalized;
};
server.get("/strategists/:address/profile", async (request, reply) => {
    const params = z.object({ address: z.string() }).parse(request.params);
    const chainConfig = await getRuntimeChainConfig();
    const normalizedAddress = normalizeAddressByChain(params.address.trim(), chainConfig.chainType);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }
    const address = normalizedAddress.toLowerCase();
    const profile = await getPlayerProfile(address);
    if (!profile) {
        return {
            address,
            displayName: null,
            createdAt: null,
            updatedAt: null,
        };
    }
    return {
        address: profile.address,
        displayName: profile.display_name,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
    };
});
server.get("/strategists/name-availability", async (request, reply) => {
    const query = z.object({
        name: z.string().optional(),
        address: z.string().optional(),
    }).parse(request.query ?? {});
    const displayName = normalizePlayerDisplayName(query.name);
    if (!displayName) {
        return reply.code(400).send({
            available: false,
            reason: "invalid",
        });
    }
    const chainConfig = await getRuntimeChainConfig();
    const normalizedRequester = query.address
        ? normalizeAddressByChain(query.address.trim(), chainConfig.chainType)
        : null;
    const existing = await getPlayerProfileByDisplayName(displayName);
    if (!existing) {
        return {
            available: true,
            reason: null,
        };
    }
    const owner = String(existing.address ?? "").toLowerCase();
    const isOwner = Boolean(normalizedRequester && owner === normalizedRequester.toLowerCase());
    return {
        available: isOwner,
        reason: isOwner ? null : "taken",
    };
});
server.post("/strategists/profile/nonce", async (request, reply) => {
    const parsed = StrategistProfileNonceSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid payload" });
    }
    const chainConfig = await getRuntimeChainConfig();
    const chainType = String(chainConfig.chainType ?? "evm").toLowerCase();
    const normalizedAddress = normalizeAddressByChain(parsed.data.address.trim(), chainType);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }

    const address = normalizedAddress.toLowerCase();
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + PLAYER_PROFILE_NONCE_TTL_MS;
    playerProfileNonces.set(address, { nonce, expiresAt });
    return {
        nonce,
        expiresAt: new Date(expiresAt).toISOString(),
    };
});
server.post("/strategists/profile", async (request, reply) => {
    const parsed = StrategistProfileUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid strategist profile payload" });
    }

    const chainConfig = await getRuntimeChainConfig();
    const chainType = String(chainConfig.chainType ?? "evm").toLowerCase();
    const normalizedAddress = normalizeAddressByChain(parsed.data.address.trim(), chainType);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }

    const displayName = normalizePlayerDisplayName(parsed.data.displayName);
    if (!displayName) {
        return reply.code(400).send({
            error: "Display name must be 3-24 chars and use letters, numbers, space, dot, underscore, hyphen.",
        });
    }

    const address = normalizedAddress.toLowerCase();

    if (chainType === "evm") {
        const nonce = String(parsed.data.nonce ?? "").trim();
        const signature = String(parsed.data.signature ?? "").trim();
        if (!nonce || !signature) {
            return reply.code(400).send({ error: "Missing nonce/signature" });
        }

        const nonceState = playerProfileNonces.get(address);
        if (!nonceState || nonceState.expiresAt < Date.now() || nonceState.nonce !== nonce) {
            return reply.code(401).send({ error: "Strategist-name approval expired. Please sign again." });
        }

        const approvalMessage = buildPlayerNameApprovalMessage(address, displayName, nonce);
        let recoveredAddress = "";
        try {
            recoveredAddress = ethers.verifyMessage(approvalMessage, signature).toLowerCase();
        }
        catch {
            return reply.code(401).send({ error: "Invalid strategist-name signature" });
        }

        if (recoveredAddress !== address) {
            return reply.code(403).send({ error: "Signature/address mismatch" });
        }

        playerProfileNonces.delete(address);
    }
    else {
        const rawSessionHeader = request.headers["x-wallet-session-address"];
        const forwardedSessionAddress = normalizeAddressByChain(
            Array.isArray(rawSessionHeader) ? rawSessionHeader[0] : rawSessionHeader,
            chainType,
        );
        const sessionAddress = forwardedSessionAddress?.toLowerCase() ?? null;
        if (!sessionAddress || sessionAddress !== address) {
            return reply.code(403).send({ error: "Session/address mismatch" });
        }

        const nonce = String(parsed.data.nonce ?? "").trim();
        const signature = normalizeStarknetSignature(parsed.data.signature);

        if (nonce && signature) {
            const nonceState = playerProfileNonces.get(address);
            if (!nonceState || nonceState.expiresAt < Date.now() || nonceState.nonce !== nonce) {
                return reply.code(401).send({ error: "Strategist-name approval expired. Please sign again." });
            }

            const chainId = resolveStarknetTypedDataChainId(chainConfig.networkKey);
            const typedData = buildStarknetPlayerNameApprovalTypedData(address, displayName, nonce, chainId);

            try {
                const verified = await withRuntimeStarknetProvider((provider) => provider.verifyMessageInStarknet(typedData as any, signature as any, address));
                if (!verified) {
                    return reply.code(401).send({ error: "Invalid strategist-name signature" });
                }
            }
            catch {
                return reply.code(401).send({ error: "Invalid strategist-name signature" });
            }

            playerProfileNonces.delete(address);
        }
    }

    try {
        const saved = await upsertPlayerProfile({
            address,
            display_name: displayName,
        });
        return {
            ok: true,
            address: saved?.address ?? address,
            displayName: saved?.display_name ?? displayName,
            createdAt: saved?.created_at ?? null,
            updatedAt: saved?.updated_at ?? null,
        };
    }
    catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === "23505") {
            return reply.code(409).send({ error: "Display name is already taken" });
        }
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to save strategist profile" });
    }
});
server.post("/errors/ingest", async (request, reply) => {
    const parsed = ErrorIngestSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid error payload" });
    }
    const payload = parsed.data;
    const nowIso = new Date().toISOString();
    const rawSessionHeader = request.headers["x-wallet-session-address"];
    const forwardedSessionAddress = normalizeMaybeAddress(Array.isArray(rawSessionHeader) ? rawSessionHeader[0] : rawSessionHeader);
    const walletAddress = normalizeMaybeAddress(payload.walletAddress);
    const sessionAddress = normalizeMaybeAddress(payload.sessionAddress) ?? forwardedSessionAddress;

    let resolvedStrategistDisplayName = String(payload.strategistDisplayName ?? "").trim();
    if (!resolvedStrategistDisplayName) {
        const profileCandidates = Array.from(new Set([walletAddress, sessionAddress].filter(Boolean)));
        for (const candidate of profileCandidates) {
            const profile = await getPlayerProfile(String(candidate));
            const displayName = String(profile?.display_name ?? "").trim();
            if (displayName) {
                resolvedStrategistDisplayName = displayName;
                break;
            }
        }
    }

    const row = await insertErrorEvent({
        event_id: payload.eventId ?? String(Date.now()) + "-" + Math.random().toString(16).slice(2),
        source: payload.source,
        severity: payload.severity,
        category: payload.category,
        message: payload.message,
        error_name: payload.errorName ?? null,
        stack: payload.stack ?? null,
        fingerprint: payload.fingerprint ?? null,
        path: payload.path ?? null,
        method: payload.method ?? null,
        status_code: payload.statusCode ?? null,
        context_json: safeJsonStringify(payload.context),
        tags_json: safeJsonStringify(payload.tags),
        release: payload.release ?? null,
        session_address: sessionAddress,
        wallet_address: walletAddress,
        strategist_display_name: resolvedStrategistDisplayName || null,
        user_agent: (payload.userAgent ?? String(request.headers["user-agent"] ?? "")).slice(0, 1024),
        ip_address: resolveClientIp(request),
        created_at: nowIso,
    });
    void maybeTriggerErrorAlert().catch((error) => {
        request.log.warn({ error }, "error-alert trigger failed");
    });
    return { ok: true, id: row?.id ?? null, createdAt: row?.created_at ?? nowIso };
});

server.post("/faucet", async (request, reply) => {
    const body = z.object({ address: z.string() }).parse(request.body);
    const rawAddress = body.address.trim();
    const chainConfig = await getRuntimeChainConfig();
    const normalizedAddress = normalizeAddressByChain(rawAddress, chainConfig.chainType);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }

    const address = normalizedAddress.toLowerCase();
    const amountRaw = env.FAUCET_STABLECOIN_AMOUNT;
    const cooldownHours = Number(env.FAUCET_COOLDOWN_HOURS || "24");
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const now = Date.now();
    const previous = await getFaucetClaim(address);

    if (previous?.last_claim_at) {
        const lastMs = new Date(previous.last_claim_at).getTime();
        if (Number.isFinite(lastMs) && now - lastMs < cooldownMs) {
            const retryAfterSeconds = Math.max(0, Math.floor((cooldownMs - (now - lastMs)) / 1000));
            return reply.code(429).send({
                error: "Faucet cooldown active",
                retryAfterSeconds,
                nextAvailableAt: new Date(lastMs + cooldownMs).toISOString(),
            });
        }
    }

    if (!chainConfig.stablecoinAddress) {
        return reply.code(500).send({ error: "Stablecoin address not configured" });
    }

    const decimals = Number(chainConfig.stablecoinDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`Invalid stablecoin decimals for runtime config: ${chainConfig.networkKey}`);
    }

    const amount = ethers.parseUnits(amountRaw, decimals);

    try {
        const txHash = await mintStablecoinOnchain(
            chainConfig.stablecoinAddress,
            normalizedAddress,
            amount,
        );

        await upsertFaucetClaim({
            address,
            last_claim_at: new Date(now).toISOString(),
            last_tx_hash: txHash,
        });

        return {
            ok: true,
            txHash,
            amount: amountRaw,
            mintedTo: normalizedAddress,
            networkKey: chainConfig.networkKey,
            stablecoinSymbol: chainConfig.stablecoinSymbol,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Faucet failed";
        return reply.code(500).send({ error: message });
    }
});
server.post("/lineups", async (_request, reply) => {
    return reply.code(410).send({
        error: "Direct lineup writes are disabled. Use /lineups/intents then /lineups/intents/:intentId/submit.",
    });
});
const normalizeLowerAddress = (rawAddress: string) => normalizeAddressByChain(String(rawAddress ?? "").trim());
const normalizeIntentSlots = (slots: Array<{ slotId: string; coinId: string }>) => slots.map((slot) => ({
    slotId: String(slot.slotId ?? "").trim(),
    coinId: String(slot.coinId ?? "").trim(),
}));
const normalizeIntentSwap = (swap: { slotId: string; removedSymbol: string; addedSymbol: string }) => ({
    slotId: String(swap.slotId ?? "").trim(),
    removedSymbol: String(swap.removedSymbol ?? "").trim().toUpperCase(),
    addedSymbol: String(swap.addedSymbol ?? "").trim().toUpperCase(),
});
server.post("/lineups/intents", async (request, reply) => {
    const parsed = LineupIntentPrepareSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid lineup intent payload" });
    }
    const body = parsed.data;
    const source = body.source;
    if (source === "swap" && !body.swap) {
        return reply.code(400).send({ error: "swap payload is required when source=swap" });
    }
    if (source !== "swap" && body.swap) {
        return reply.code(400).send({ error: "swap payload is only allowed when source=swap" });
    }
    const normalizedAddress = normalizeLowerAddress(body.address);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }
    const slots = normalizeIntentSlots(body.slots);
    const uniqueSlotIds = new Set(slots.map((slot) => slot.slotId));
    if (uniqueSlotIds.size !== slots.length || slots.some((slot) => !slot.slotId || !slot.coinId)) {
        return reply.code(400).send({ error: "Invalid slots payload" });
    }
    const weekId = String(body.weekId ?? "").trim();
    if (!weekId) {
        return reply.code(400).send({ error: "weekId is required" });
    }
    const swapPayload = source === "swap" && body.swap ? normalizeIntentSwap(body.swap) : null;
    if (swapPayload && (!swapPayload.slotId || !swapPayload.removedSymbol || !swapPayload.addedSymbol)) {
        return reply.code(400).send({ error: "Invalid swap payload" });
    }
    try {
        let created: any = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const intentId = randomBytes(16).toString("hex");
            try {
                created = await createLineupTxIntent({
                    id: intentId,
                    week_id: weekId,
                    address: normalizedAddress,
                    source,
                    slots_json: JSON.stringify(slots),
                    swap_json: swapPayload ? JSON.stringify(swapPayload) : null,
                });
                break;
            }
            catch (error) {
                const code = (error as { code?: string } | null)?.code;
                if (code === "23505") {
                    continue;
                }
                throw error;
            }
        }
        if (!created?.id) {
            throw new Error("Failed to allocate lineup intent id");
        }
        return {
            ok: true,
            intent: {
                id: created.id,
                weekId: created.week_id,
                address: created.address,
                source: created.source,
                status: created.status,
                createdAt: created.created_at,
            },
        };
    }
    catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to create lineup intent" });
    }
});
server.post("/lineups/intents/:intentId/cancel", async (request, reply) => {
    const params = z.object({ intentId: z.string().min(8) }).safeParse(request.params);
    if (!params.success) {
        return reply.code(400).send({ error: "Invalid intent id" });
    }
    const parsed = LineupIntentCancelSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid lineup intent cancel payload" });
    }
    const normalizedAddress = normalizeLowerAddress(parsed.data.address);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }
    const intentId = params.data.intentId.trim();
    const intent = await getLineupTxIntentById(intentId);
    if (!intent) {
        return reply.code(404).send({ error: "Lineup intent not found" });
    }
    if (String(intent.address ?? "").toLowerCase() !== normalizedAddress) {
        return reply.code(403).send({ error: "Intent/address mismatch" });
    }
    if (String(intent.status ?? "") === "completed") {
        return reply.code(409).send({ error: "Completed intent cannot be canceled" });
    }
    const reason = String(parsed.data.reason ?? "").trim() || "intent canceled by client";
    const updated = await markLineupTxIntentFailed(intentId, reason);
    if (!updated) {
        return reply.code(409).send({ error: "Lineup intent could not be canceled" });
    }
    return {
        ok: true,
        intent: {
            id: updated.id,
            status: updated.status,
            lastError: updated.last_error ?? null,
            resolvedAt: updated.resolved_at ?? null,
        },
    };
});
server.post("/lineups/intents/:intentId/submit", async (request, reply) => {
    const params = z.object({ intentId: z.string().min(8) }).safeParse(request.params);
    if (!params.success) {
        return reply.code(400).send({ error: "Invalid intent id" });
    }
    const parsed = LineupIntentSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid lineup intent submit payload" });
    }
    const normalizedAddress = normalizeLowerAddress(parsed.data.address);
    if (!normalizedAddress) {
        return reply.code(400).send({ error: "Invalid address" });
    }
    const intentId = params.data.intentId.trim();
    const txHash = parsed.data.txHash.toLowerCase();
    const intent = await getLineupTxIntentById(intentId);
    if (!intent) {
        return reply.code(404).send({ error: "Lineup intent not found" });
    }
    if (String(intent.address ?? "").toLowerCase() !== normalizedAddress) {
        return reply.code(403).send({ error: "Intent/address mismatch" });
    }
    const existingTxHash = String(intent.tx_hash ?? "").toLowerCase();
    if (existingTxHash && existingTxHash !== txHash) {
        return reply.code(409).send({ error: "Intent already bound to a different tx hash" });
    }
    if (!existingTxHash) {
        const other = await getLineupTxIntentByTxHash(txHash);
        if (other && String(other.id ?? "") !== intentId) {
            return reply.code(409).send({ error: "tx hash already used by another intent" });
        }
    }
    if (String(intent.status ?? "") === "completed") {
        return {
            ok: true,
            synced: true,
            healing: false,
            requiresAttention: false,
            task: {
                id: intent.self_heal_task_id ?? null,
                status: "success",
            },
        };
    }
    let slots: Array<{ slotId: string; coinId: string }> = [];
    try {
        const parsedSlots = JSON.parse(String(intent.slots_json ?? "[]"));
        if (!Array.isArray(parsedSlots)) {
            return reply.code(409).send({ error: "Intent slots payload is invalid" });
        }
        slots = normalizeIntentSlots(parsedSlots as Array<{ slotId: string; coinId: string }>);
    }
    catch {
        return reply.code(409).send({ error: "Intent slots payload is invalid" });
    }
    if (slots.length !== 11 || slots.some((slot) => !slot.slotId || !slot.coinId)) {
        return reply.code(409).send({ error: "Intent slots payload is invalid" });
    }
    const source = String(intent.source ?? "commit") === "swap" ? "swap" : "commit";
    let swapPayload: { slotId: string; removedSymbol: string; addedSymbol: string } | undefined = undefined;
    if (source === "swap") {
        if (!intent.swap_json) {
            return reply.code(409).send({ error: "Intent swap payload is missing" });
        }
        try {
            const parsedSwap = JSON.parse(String(intent.swap_json));
            swapPayload = normalizeIntentSwap(parsedSwap as { slotId: string; removedSymbol: string; addedSymbol: string });
        }
        catch {
            return reply.code(409).send({ error: "Intent swap payload is invalid" });
        }
        if (!swapPayload.slotId || !swapPayload.removedSymbol || !swapPayload.addedSymbol) {
            return reply.code(409).send({ error: "Intent swap payload is invalid" });
        }
    }
    const submittedIntent = await markLineupTxIntentSubmitted(intentId, txHash);
    if (!submittedIntent) {
        return reply.code(409).send({ error: "Failed to bind tx hash to intent" });
    }
    try {
        const task = await enqueueLineupSyncTask({
            txHash,
            source,
            weekIdHint: String(intent.week_id ?? "").trim() || undefined,
            addressHint: normalizedAddress,
            slots,
            swap: swapPayload,
        });
        const synced = task.status === "success";
        if (synced) {
            await markLineupTxIntentCompleted(intentId, Number(task.id));
        }
        else if (task.status === "dead" || task.status === "canceled") {
            await markLineupTxIntentFailed(intentId, task.last_error ?? "lineup sync failed");
        }
        else {
            await markLineupTxIntentHealing(intentId, Number(task.id), task.last_error ?? null);
        }
        return reply.code(synced ? 200 : 202).send({
            ok: true,
            synced,
            healing: !synced,
            requiresAttention: task.status === "dead" || task.status === "canceled",
            task: {
                id: task.id,
                status: task.status,
                attemptCount: task.attempt_count,
                maxAttempts: task.max_attempts,
                nextAttemptAt: task.next_attempt_at,
                lastErrorCode: task.last_error_code,
            },
        });
    }
    catch (error) {
        request.log.error(error);
        await markLineupTxIntentFailed(intentId, error instanceof Error ? error.message : "lineup sync enqueue failed");
        return reply.code(500).send({ error: "Lineup sync enqueue failed" });
    }
});
server.post("/lineups/sync", async (request, reply) => {
    const parsed = LineupSyncSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid lineup sync payload" });
    }
    const body = parsed.data;
    try {
        const source = body.source ?? "commit";
        if (source === "swap" && !body.swap) {
            return reply.code(400).send({ error: "swap payload is required when source=swap" });
        }
        if (source !== "swap" && body.swap) {
            return reply.code(400).send({ error: "swap payload is only allowed when source=swap" });
        }
        const task = await enqueueLineupSyncTask({
            txHash: body.txHash,
            source,
            weekIdHint: body.weekId?.trim() || undefined,
            addressHint: body.addressHint ? String(body.addressHint).trim().toLowerCase() : undefined,
            slots: body.slots.map((slot) => ({
                slotId: slot.slotId.trim(),
                coinId: slot.coinId.trim(),
            })),
            swap: source === "swap" && body.swap
                ? {
                    slotId: body.swap.slotId.trim(),
                    removedSymbol: body.swap.removedSymbol.trim().toUpperCase(),
                    addedSymbol: body.swap.addedSymbol.trim().toUpperCase(),
                }
                : undefined,
        });
        const synced = task.status === "success";
        return reply.code(synced ? 200 : 202).send({
            ok: true,
            synced,
            healing: !synced,
            requiresAttention: task.status === "dead" || task.status === "canceled",
            task: {
                id: task.id,
                status: task.status,
                attemptCount: task.attempt_count,
                maxAttempts: task.max_attempts,
                nextAttemptAt: task.next_attempt_at,
                lastErrorCode: task.last_error_code,
            },
        });
    }
    catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Lineup sync enqueue failed" });
    }
});
server.get("/prices/live", async () => {
    const weeks = await getWeeks();
    const currentWeekRow = getCurrentPublicWeek(weeks);
    if (!currentWeekRow) {
        return {};
    }
    const currentWeek = WeekRowSchema.parse(currentWeekRow);
    const weekCoins = await getWeekCoins(currentWeek.id);
    const allCoins = await getCoins();
    const coinMap = new Map(allCoins.map((coin) => [coin.id, coin]));
    const symbols = weekCoins
        .map((wc) => coinMap.get(wc.coin_id)?.symbol ?? "")
        .filter(Boolean);
    const prices = await getLivePrices(symbols);
    return prices;
});
server.get("/strategies/:strategyId", async (request, reply) => {
    const params = z.object({ strategyId: z.string().trim().min(1) }).parse(request.params);
    const strategy = await getStrategyById(params.strategyId);
    if (!strategy) {
        return reply.code(404).send({ error: "Strategy not found" });
    }
    const [recentEpochs, recentSeasons] = await Promise.all([
        getStrategyEpochEntries(params.strategyId, 24),
        getStrategySeasonEntries(params.strategyId, 6),
    ]);
    return {
        ...strategy,
        recentEpochs,
        recentSeasons,
    };
});

server.get("/epochs/:epochId/strategies", async (request) => {
    const params = z.object({ epochId: z.string().trim().min(1) }).parse(request.params);
    const query = z.object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query ?? {});

    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(100, query.pageSize));
    const offset = (page - 1) * pageSize;
    const result = await getEpochStrategies(params.epochId, { limit: pageSize, offset });
    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));

    return {
        epochId: params.epochId,
        page,
        pageSize,
        total: result.total,
        totalPages,
        rows: result.rows,
    };
});

server.get("/leaderboard/strategies", async (request) => {
    const query = z.object({
        epochId: z.string().trim().optional(),
        scope: z.enum(["all_time", "season"]).optional(),
        seasonId: z.string().trim().max(40).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query ?? {});

    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(100, query.pageSize));
    const offset = (page - 1) * pageSize;
    const epochId = String(query.epochId ?? "").trim();
    const scope = query.scope ?? "all_time";
    const seasonId = String(query.seasonId ?? "").trim();

    const result = await getStrategyLeaderboardRows({
        epochId,
        scope,
        seasonId,
        limit: pageSize,
        offset,
    });
    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));

    const resolvedSeasonId =
        scope === "season"
            ? (("seasonId" in result ? result.seasonId : seasonId) || null)
            : null;

    return {
        epochId: epochId || null,
        scope,
        seasonId: resolvedSeasonId,
        page,
        pageSize,
        total: result.total,
        totalPages,
        rows: result.rows,
    };
});

server.get("/weeks/:weekId/results/:address", async (request, reply) => {
    const params = z
        .object({ weekId: z.string(), address: z.string() })
        .parse(request.params);
    try {
        const { getLineupResult } = await import("./services/scoring.service.js");
        const lineupId = `${params.weekId}-${params.address.toLowerCase()}`;
        const result = await getLineupResult(params.weekId, lineupId);
        if (!result) {
            return reply.code(404).send({ error: "Result not found" });
        }
        return result;
    }
    catch (error) {
        return reply.code(404).send({ error: "Result not found" });
    }
});
server.get("/admin/errors/summary", async (request) => {
    const query = ErrorSummaryQuerySchema.parse(request.query ?? {});
    const summary = await getErrorEventsSummary(query.windowHours);
    return {
        ...summary,
        alerts: getErrorAlertPublicConfig(),
    };
});
server.get("/admin/errors", async (request) => {
    const query = ErrorListQuerySchema.parse(request.query ?? {});
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(100, query.pageSize));
    const offset = (page - 1) * pageSize;
    const result = await listErrorEvents({
        limit: pageSize,
        offset,
        severity: query.severity,
        source: query.source,
        category: query.category,
        acknowledged: query.ack ?? "all",
        actionable: query.actionable ?? "all",
        incidentState: query.incidentState,
        search: query.q,
    });
    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
    return {
        page,
        pageSize,
        total: result.total,
        totalPages,
        rows: result.rows,
    };
});
server.get("/admin/errors/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: "Invalid error id" });
    }
    const row = await getErrorEventById(id);
    if (!row) {
        return reply.code(404).send({ error: "Error event not found" });
    }
    return row;
});
server.post("/admin/errors/:id/ack", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ acknowledgedBy: z.string().trim().max(120).optional() }).parse(request.body ?? {});
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: "Invalid error id" });
    }
    const result = await acknowledgeErrorEvent(id, body.acknowledgedBy ?? "ops-console");
    if (!result) {
        return reply.code(404).send({ error: "Error event not found" });
    }
    return { ok: true, row: result.row, affected: result.affected, mode: result.mode };
});
server.get("/admin/errors/incidents/summary", async (request) => {
    const query = ErrorSummaryQuerySchema.parse(request.query ?? {});
    return getErrorIncidentsSummary(query.windowHours);
});
server.get("/admin/errors/incidents", async (request) => {
    const query = ErrorIncidentListQuerySchema.parse(request.query ?? {});
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(100, query.pageSize));
    const offset = (page - 1) * pageSize;
    const result = await listErrorIncidents({
        limit: pageSize,
        offset,
        state: query.state,
        source: query.source,
        search: query.q,
    });
    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
    return {
        page,
        pageSize,
        total: result.total,
        totalPages,
        rows: result.rows,
    };
});
server.post("/admin/errors/incidents/:id/state", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ state: ErrorIncidentStateSchema }).parse(request.body ?? {});
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: "Invalid incident id" });
    }
    const row = await setErrorIncidentState(id, body.state);
    if (!row) {
        return reply.code(404).send({ error: "Incident not found" });
    }
    return { ok: true, row };
});
server.get("/admin/errors/suppress-rules", async () => {
    const rows = await listErrorSuppressRules();
    return { rows };
});
server.post("/admin/errors/suppress-rules", async (request, reply) => {
    const body = ErrorSuppressRuleInputSchema.parse(request.body ?? {});
    const row = await createErrorSuppressRule({
        name: body.name,
        enabled: body.enabled === undefined ? 1 : (body.enabled === true || body.enabled === 1 ? 1 : 0),
        source: body.source || null,
        category: body.category || null,
        fingerprint: body.fingerprint || null,
        path_pattern: body.pathPattern || null,
        method: body.method || null,
        status_code: body.statusCode ?? null,
        message_pattern: body.messagePattern || null,
        severity: body.severity || null,
        notes: body.notes || null,
    });
    if (!row) {
        return reply.code(500).send({ error: "Failed to create rule" });
    }
    return { ok: true, row };
});
server.patch("/admin/errors/suppress-rules/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = ErrorSuppressRulePatchSchema.parse(request.body ?? {});
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: "Invalid rule id" });
    }
    const row = await updateErrorSuppressRule(id, {
        name: body.name ?? null,
        enabled: body.enabled === undefined ? null : (body.enabled === true || body.enabled === 1 ? 1 : 0),
        source: body.source ?? null,
        category: body.category ?? null,
        fingerprint: body.fingerprint ?? null,
        path_pattern: body.pathPattern ?? null,
        method: body.method ?? null,
        status_code: body.statusCode ?? null,
        message_pattern: body.messagePattern ?? null,
        severity: body.severity ?? null,
        notes: body.notes ?? null,
    });
    if (!row) {
        return reply.code(404).send({ error: "Rule not found" });
    }
    return { ok: true, row };
});
server.delete("/admin/errors/suppress-rules/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: "Invalid rule id" });
    }
    const row = await deleteErrorSuppressRule(id);
    if (!row) {
        return reply.code(404).send({ error: "Rule not found" });
    }
    return { ok: true, row };
});
server.get("/admin/status", async () => {
    const weeks = await getWeeks();
    const current = weeks[0] ? WeekRowSchema.parse(weeks[0]) : null;
    const currentWeek = current
        ? {
            id: current.id,
            startAtUtc: current.start_at,
            lockAtUtc: current.lock_at,
            endAtUtc: current.end_at,
            status: current.status,
        }
        : null;
    const coins = await getCoins();
    const weekCoins = current ? await getWeekCoins(current.id) : [];
    const lineups = current ? await getLineups(current.id) : [];
    const results = current ? await getWeeklyResults(current.id) : [];
    const runtime = await getRuntimeChainConfig().catch(() => null);
    const dbBinding = await getDbRuntimeBinding().catch(() => null);
    const leagueAddress = runtime?.valcoreAddress ?? null;
    const automation = await resolveAutomationRuntime();
    return {
        serverTime: new Date().toISOString(),
        timeMode: automation.timeMode,
        automationMode: automation.mode,
        automationConfiguredMode: automation.baseMode,
        automationTickMs: AUTOMATION_TICK_MS,
        automationReactiveSupported: automation.reactiveSupported,
        automationSupportReason: automation.supportReason,
        automationFailoverActive: automation.failoverActive,
        automationFailoverMode: automation.failoverMode,
        automationFailoverReason: automation.failoverReason,
        automationFailoverActivatedAt: automation.failoverActivatedAt,
        chainEnabled: Boolean(isValcoreChainEnabled() && runtime?.oraclePrivateKey && leagueAddress),
        leagueContractSet: Boolean(leagueAddress),
        stablecoinAddressSet: Boolean(runtime?.stablecoinAddress),
        stablecoinSymbol: runtime?.stablecoinSymbol ?? null,
        pauserAddress: runtime?.pauserAddress ?? null,
        activeNetworkKey: runtime?.networkKey ?? null,
        activeNetworkLabel: runtime?.label ?? null,
        activeChainId: runtime?.chainId ?? null,
        activeRpcConfigured: Boolean(runtime?.rpcUrl),
        dbBinding,
        currentWeek,
        counts: {
            coins: coins.length,
            weekCoins: weekCoins.length,
            lineups: lineups.length,
            weeklyResults: results.length,
        },
    };
});
server.post("/admin/automation/tick", async (request, reply) => {
    if (!isAdminAuthorized(request)) {
        return reply.code(401).send({ error: "Unauthorized" });
    }
    await runAutomationTick();
    const automation = await resolveAutomationRuntime();
    return {
        ok: true,
        automationMode: automation.mode,
        configuredMode: automation.baseMode,
        timeMode: automation.timeMode,
        reactiveSupported: automation.reactiveSupported,
        supportReason: automation.supportReason,
        failoverActive: automation.failoverActive,
        failoverMode: automation.failoverMode,
        failoverReason: automation.failoverReason,
        failoverActivatedAt: automation.failoverActivatedAt,
    };
});
server.post("/admin/automation/failover/reset", async (request, reply) => {
    if (!isAdminAuthorized(request)) {
        return reply.code(401).send({ error: "Unauthorized" });
    }
    return reply.code(409).send({
        error: "Automation halt reset is disabled in strict mode. Change env + redeploy to recover.",
    });
});
server.get("/admin/finance/week", async (request, reply) => {
    const query = z.object({ weekId: z.string().optional() }).parse(request.query ?? {});
    const weeks = await getWeeks();
    const activeWeek = weeks.find((row) => String(row.status ?? "").toUpperCase() === "ACTIVE");
    const weekId = query.weekId ?? activeWeek?.id ?? weeks[0]?.id;
    if (!weekId) {
        return reply.code(404).send({ error: "No week found" });
    }
    const payload = await buildWeekFinancePayload(weekId);
    if (!payload) {
        return reply.code(404).send({ error: "Week not found" });
    }
    return payload;
});
server.get("/admin/finance/all-time", async () => {
    return buildAllTimeFinancePayload();
});
server.post("/admin/finance/week/sweep-expired", async (request, reply) => {
    const body = z.object({ weekId: z.string() }).parse(request.body ?? {});
    if (rewardSweepInProgress) {
        return reply.code(409).send({ error: "Reward sweep already running" });
    }
    rewardSweepInProgress = true;
    try {
        const result = await sweepExpiredRewardsForWeek(body.weekId);
        return { ok: true, result };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Failed to sweep expired rewards";
        return reply.code(400).send({ error: message });
    }
    finally {
        rewardSweepInProgress = false;
    }
});
server.get("/admin/jobs", async () => ({
    running: hasRunningJob(),
    jobs: listJobStatuses(),
}));
server.get("/admin/mock-lineups/meta", async (request, reply) => {
    const query = z.object({ weekId: z.string().optional() }).parse(request.query ?? {});
    const weeks = await getWeeks();
    const weekId = query.weekId ?? weeks[0]?.id;
    if (!weekId) {
        return reply.code(404).send({ error: "No week found" });
    }
    const mockLineups = await getMockLineups(weekId);
    return {
        weekId,
        count: mockLineups.length,
    };
});
server.get("/score-models/meta", async (request, reply) => {
    const query = z.object({ weekId: z.string().optional() }).parse(request.query ?? {});
    const weeks = await getWeeks();
    const weekId = query.weekId ?? weeks[0]?.id;
    if (!weekId) {
        return reply.code(404).send({ error: "No week found" });
    }
    const mockLineups = await getMockLineups(weekId);
    return {
        weekId,
        count: mockLineups.length,
        modelKeys: WEEK_SCORE_MODEL_ORDER,
        models: getWeekScoreModelCatalog(),
    };
});

server.get("/admin/job-logs", async () => {
    const incidents = await listJobRunIncidents(50);
    return { incidents };
});
server.get("/admin/mock-lineups/scores", async (request, reply) => {
    const query = z.object({ weekId: z.string().optional() }).parse(request.query ?? {});
    const weeks = await getWeeks();
    const weekId = query.weekId ?? weeks[0]?.id;
    if (!weekId) {
        return reply.code(404).send({ error: "No week found" });
    }
    const scores = await getMockLineupLiveScores(weekId);
    return {
        weekId,
        count: scores.length,
        benchmarkPnlPercent: scores[0]?.benchmarkPnlPercent ?? 0,
        scores,
    };
});
server.post("/admin/mock-lineups/generate", async (request, reply) => {
    const body = z
        .object({
        weekId: z.string().optional(),
        count: z.number().int().min(1).max(100).optional(),
    })
        .parse(request.body ?? {});
    const weeks = await getWeeks();
    const weekId = body.weekId ?? weeks[0]?.id;
    if (!weekId) {
        return reply.code(404).send({ error: "No week found" });
    }
    const generated = await generateMockLineups(weekId, body.count ?? 10);
    const scores = await getMockLineupLiveScores(weekId);
    return {
        ok: true,
        weekId,
        generated: generated.length,
        benchmarkPnlPercent: scores[0]?.benchmarkPnlPercent ?? 0,
        scores,
    };
});
server.post("/admin/mock-lineups/snapshots/clear", async () => {
    const deletedCount = await clearMockScoreAggregates();
    return {
        ok: true,
        deletedCount,
    };
});
server.get("/admin/mock-lineups/snapshots/analytics", async (request, reply) => {
    const query = z
        .object({
        weekId: z.string().optional(),
        window: z.enum(["5m", "15m", "30m", "1h", "4h", "12h", "24h", "3d", "1w"]).optional(),
        model: z.string().optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
    })
        .parse(request.query ?? {});
    try {
        const analytics = await getMockLineupSnapshotAnalytics({
            weekId: query.weekId,
            window: query.window,
            modelKey: query.model,
            startAt: query.startAt,
            endAt: query.endAt,
        });
        if (!analytics) {
            return reply.code(404).send({ error: "No week found" });
        }
        return analytics;
    }
    catch (error) {
        const text = error instanceof Error ? error.message : "Invalid analytics query";
        return reply.code(400).send({ error: text });
    }
});
server.get("/admin/mock-lineups/snapshots/compare", async (request, reply) => {
    const query = z
        .object({
        weekId: z.string().optional(),
        window: z.enum(["5m", "15m", "30m", "1h", "4h", "12h", "24h", "3d", "1w"]).optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
    })
        .parse(request.query ?? {});
    try {
        const comparison = await getMockLineupSnapshotComparison({
            weekId: query.weekId,
            window: query.window,
            startAt: query.startAt,
            endAt: query.endAt,
        });
        if (!comparison) {
            return reply.code(404).send({ error: "No week found" });
        }
        return comparison;
    }
    catch (error) {
        const text = error instanceof Error ? error.message : "Invalid comparison query";
        return reply.code(400).send({ error: text });
    }
});
server.get("/score-models/snapshots/matrix", async (request, reply) => {
    const query = z
        .object({
        weekId: z.string().optional(),
        window: z.enum(["5m", "15m", "30m", "1h", "4h", "12h", "24h", "3d", "1w"]).optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
    })
        .parse(request.query ?? {});
    try {
        const matrix = await getMockLineupSnapshotModelMatrix({
            weekId: query.weekId,
            window: query.window,
            startAt: query.startAt,
            endAt: query.endAt,
        });
        if (!matrix) {
            return reply.code(404).send({ error: "No week found" });
        }
        return matrix;
    }
    catch (error) {
        const text = error instanceof Error ? error.message : "Invalid matrix query";
        return reply.code(400).send({ error: text });
    }
});

server.get("/admin/self-heal", async () => {
    const dashboard = await getSelfHealDashboard();
    return dashboard;
});
server.post("/admin/self-heal/sweep", async () => {
    await runSelfHealSweep();
    const dashboard = await getSelfHealDashboard();
    return { ok: true, dashboard };
});
server.post("/admin/self-heal/tasks/:taskId/retry", async (request, reply) => {
    const params = z.object({ taskId: z.string() }).parse(request.params);
    const taskId = Number(params.taskId);
    if (!Number.isFinite(taskId) || taskId <= 0) {
        return reply.code(400).send({ error: "Invalid task id" });
    }
    const task = await retrySelfHealTaskById(taskId);
    if (!task) {
        return reply.code(404).send({ error: "Task not found" });
    }
    return { ok: true, task };
});
server.post("/admin/self-heal/tasks/:taskId/cancel", async (request, reply) => {
    const params = z.object({ taskId: z.string() }).parse(request.params);
    const taskId = Number(params.taskId);
    if (!Number.isFinite(taskId) || taskId <= 0) {
        return reply.code(400).send({ error: "Invalid task id" });
    }
    const task = await cancelSelfHealTaskById(taskId);
    if (!task) {
        return reply.code(404).send({ error: "Task not found" });
    }
    return { ok: true, task };
});
server.post("/admin/jobs/stop", async (request) => {
    const body = z.object({ name: z.string().optional() }).parse(request.body ?? {});
    const result = await stopJob(body.name);
    return { ok: true, ...result };
});
server.post("/admin/jobs/run-week", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const weeks = await getWeeks();
    const current = weeks[0];
    const currentStatus = String(current?.status ?? "").toUpperCase();
    if (["DRAFT_OPEN", "LOCKED", "ACTIVE", "FINALIZE_PENDING"].includes(currentStatus)) {
        return reply.code(409).send({
            error: `Cannot run new week while current week is ${currentStatus || "UNKNOWN"}`,
        });
    }
    const status = await startJob("run-week", "node", ["dist/jobs/job-week.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/refresh-week-coins", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const weeks = await getWeeks();
    const current = weeks[0];
    const currentStatus = String(current?.status ?? "").toUpperCase();
    if (currentStatus !== "DRAFT_OPEN") {
        return reply.code(409).send({ error: `Refresh week coins requires DRAFT_OPEN week; got ${currentStatus || "UNKNOWN"}` });
    }
    const status = await startJob("refresh-week-coins", "node", ["dist/jobs/run-refresh-week-coins.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/transition", async (request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const body = z.object({ action: z.enum(["lock", "start"]) }).parse(request.body);
    const status = await startJob(`transition-${body.action}`, "node", ["dist/jobs/run-transition.js", body.action]);
    return { ok: true, status };
});
server.post("/admin/jobs/finalize", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const weeks = await getWeeks();
    const currentStatus = String(weeks[0]?.status ?? "").toUpperCase();
    if (currentStatus !== "ACTIVE") {
        return reply.code(409).send({ error: `Finalize requires ACTIVE week; got ${currentStatus || "UNKNOWN"}` });
    }
    const status = await startJob("finalize", "node", ["dist/jobs/run-finalize.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/finalize-audit", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const weeks = await getWeeks();
    const currentStatus = String(weeks[0]?.status ?? "").toUpperCase();
    if (currentStatus !== "FINALIZE_PENDING") {
        return reply.code(409).send({ error: `Audit requires FINALIZE_PENDING week; got ${currentStatus || "UNKNOWN"}` });
    }
    const status = await startJob("finalize-audit", "node", ["dist/jobs/run-finalize-audit.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/finalize-reject", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const weeks = await getWeeks();
    const currentStatus = String(weeks[0]?.status ?? "").toUpperCase();
    if (currentStatus !== "FINALIZE_PENDING") {
        return reply.code(409).send({ error: `Reject requires FINALIZE_PENDING week; got ${currentStatus || "UNKNOWN"}` });
    }
    const status = await startJob("finalize-reject", "node", ["dist/jobs/run-finalize-reject.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/pause", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const status = await startJob("pause", "node", ["dist/jobs/run-pause.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/unpause", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const status = await startJob("unpause", "node", ["dist/jobs/run-unpause.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/time-mode", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const status = await startJob("time-mode", "node", ["dist/jobs/run-time-mode.js"]);
    return { ok: true, status };
});
server.post("/admin/jobs/reset-db", async (_request, reply) => {
    if (hasRunningJob()) {
        return reply.code(409).send({ error: "Another job is already running" });
    }
    const status = await startJob("reset-db", "node", ["dist/jobs/run-reset-db.js"]);
    return { ok: true, status };
});
const emitWeekSnapshot = async () => {
    if (sseClients.size === 0)
        return;
    const snapshot = await buildWeekSnapshot();
    const signature = snapshotSignature(snapshot);
    if (signature === lastWeekSignature)
        return;
    lastWeekSignature = signature;
    broadcastSse("week", snapshot);
};
setInterval(() => {
    void emitWeekSnapshot().catch((error) => {
        server.log.error({ error }, "emitWeekSnapshot failed");
    });
}, 2000);
const AUTOMATION_GUARDED_JOB_NAMES = new Set([
    "run-week",
    "transition-lock",
    "transition-start",
    "finalize",
    "finalize-audit",
]);
const maybeRecoverAutomationFailureFromDrift = async (jobName: string, status: Record<string, unknown>) => {
    const weekId = String((status as { weekId?: string | null }).weekId ?? "").trim();
    const latestWeeks = await getWeeks();
    const current = weekId ? (await getWeekById(weekId)) ?? latestWeeks[0] : latestWeeks[0];
    if (!current) {
        return false;
    }
    const dbStatus = String(current.status ?? "").toUpperCase();
    if (!["DRAFT_OPEN", "LOCKED", "ACTIVE", "FINALIZE_PENDING", "FINALIZED"].includes(dbStatus)) {
        return false;
    }
    const leagueAddress = await getRuntimeValcoreAddress().catch(() => null);
    if (!leagueAddress) {
        return false;
    }
    const drift = await reconcileWeekStatusDrift({
        context: `automation-failure/${jobName}`,
        weekId: String(current.id),
        dbStatus,
        leagueAddress,
    });
    return drift.reconciled;
};
const maybeEscalateAutomationFailure = async (event: { name?: string; status?: Record<string, unknown> } | null | undefined) => {
    const jobName = String(event?.name ?? "");
    if (!AUTOMATION_GUARDED_JOB_NAMES.has(jobName))
        return;
    const status = event?.status ?? {};
    const state = String((status as { state?: string }).state ?? "").toLowerCase();
    const nextRetryAt = String((status as { nextRetryAt?: string | null }).nextRetryAt ?? "").trim();
    if (state !== "error" || nextRetryAt) {
        return;
    }
    const recovered = await maybeRecoverAutomationFailureFromDrift(jobName, status as Record<string, unknown>).catch(() => false);
    if (recovered) {
        return;
    }
    const runtime = await resolveAutomationRuntime();
    if (runtime.mode === "REACTIVE") {
        await haltAutomation(`Reactive mode failure on ${jobName}`, {
            jobName,
            error: (status as { error?: string | null }).error ?? null,
            lastError: (status as { lastError?: string | null }).lastError ?? null,
        });
        return;
    }
    if (runtime.mode === "CRON") {
        await haltAutomation(`Cron mode failure on ${jobName}`, {
            jobName,
            error: (status as { error?: string | null }).error ?? null,
            lastError: (status as { lastError?: string | null }).lastError ?? null,
        });
    }
};
jobsEvents.on("job:finished", (event) => {
    void emitWeekSnapshot().catch((error) => {
        server.log.error({ error }, "emitWeekSnapshot failed");
    });

    const jobName = event?.name;
    if (jobName === "run-week" || jobName === "transition-lock" || jobName === "transition-start") {
        void runAutoShowcase();
    }

    void maybeEscalateAutomationFailure(event as { name?: string; status?: Record<string, unknown> }).catch((error) => {
        server.log.error({ error }, "automation halt escalation failed");
    });
});
let automationTickRunning = false;
let lastAutomationUnsupportedAlertAt = 0;
const startAutomationJob = async (name: string, _args: string[]) => {
    const runtime = await resolveAutomationRuntime();
    const envOverrides = {
        AUTOMATION_MODE_EFFECTIVE: runtime.mode,
    };
    if (name === "run-week") {
        await startJob(name, "node", ["dist/jobs/job-week.js"], envOverrides);
        return;
    }
    if (name === "transition-lock") {
        await startJob(name, "node", ["dist/jobs/run-transition.js", "lock"], envOverrides);
        return;
    }
    if (name === "transition-start") {
        await startJob(name, "node", ["dist/jobs/run-transition.js", "start"], envOverrides);
        return;
    }
    if (name === "finalize") {
        await startJob(name, "node", ["dist/jobs/run-finalize.js"], envOverrides);
        return;
    }
    if (name === "finalize-audit") {
        await startJob(name, "node", ["dist/jobs/run-finalize-audit.js"], envOverrides);
        return;
    }
    if (name === "refresh-week-coins") {
        await startJob(name, "node", ["dist/jobs/run-refresh-week-coins.js"], envOverrides);
        return;
    }
    await startJob(name, "node", ["dist/jobs/job-week.js"], envOverrides);
};
const runAutomationTick = async () => {
    if (automationTickRunning)
        return;
    if (hasRunningJob())
        return;
    automationTickRunning = true;
    try {
        const automation = await resolveAutomationRuntime();
        if (automation.mode === "MANUAL")
            return;
        if (automation.failoverActive) {
            return;
        }
        if (automation.mode === "REACTIVE" && !automation.reactiveSupported) {
            const now = Date.now();
            if (now - lastAutomationUnsupportedAlertAt >= AUTOMATION_UNSUPPORTED_ALERT_COOLDOWN_MS) {
                lastAutomationUnsupportedAlertAt = now;
                server.log.warn({ automation }, "Reactive automation unsupported for current profile; halting");
            }
            await haltAutomation(automation.supportReason, {
                supportReason: automation.supportReason,
                chainType: automation.chainType,
                chainId: automation.chainId,
                chainKey: automation.chainKey,
            });
            return;
        }
        const weeks = await getWeeks();
        let current = weeks[0];
        if (!current) {
            await startAutomationJob("run-week", ["run", "job:week"]);
            return;
        }
        const leagueAddress = await getRuntimeValcoreAddress().catch(() => null);
        if (leagueAddress) {
            const drift = await reconcileWeekStatusDrift({
                context: "automation-tick",
                weekId: current.id,
                dbStatus: String(current.status ?? ""),
                leagueAddress,
            });
            if (drift.reconciled) {
                const refreshed = await getWeekById(String(current.id));
                if (refreshed) {
                    current = refreshed;
                }
            }
        }
        const status = String(current.status ?? "").toUpperCase();
        const nowMs = Date.now();
        const createdAtMs = Date.parse(String(current.created_at ?? ""));
        const startAtMs = Date.parse(String(current.start_at ?? ""));
        const lockAtMs = Date.parse(String(current.lock_at ?? ""));
        const endAtMs = Date.parse(String(current.end_at ?? ""));
        const finalizedAtMs = Date.parse(String(current.finalized_at ?? ""));
        const isReactiveMode = automation.mode === "REACTIVE";
        if (status === "PREPARING") {
            if (isReactiveMode) {
                const preparingBaselineMs = Number.isFinite(createdAtMs) ? createdAtMs : lockAtMs;
                if (Number.isFinite(preparingBaselineMs) && nowMs >= preparingBaselineMs + REACTIVE_STALL_GRACE_MS) {
                    await haltAutomation("Reactive week creation missed deadline", {
                        weekId: current.id,
                        status,
                        createdAt: current.created_at ?? null,
                        lockAt: current.lock_at ?? null,
                        nowMs,
                        graceMs: REACTIVE_STALL_GRACE_MS,
                    });
                }
            }
            await startAutomationJob("run-week", ["run", "job:week"]);
            return;
        }
        if (status === "DRAFT_OPEN") {
            const lineups = await getLineups(current.id);
            const runtime = await getRuntimeChainConfig().catch(() => null);
            const runtimeChainType = String(runtime?.chainType ?? "").toLowerCase();
            const hasSentinelKey = String(env.SENTINEL_PRIVATE_KEY ?? "").trim().length > 0;
            const hasSentinelAccount = String(env.SENTINEL_ACCOUNT_ADDRESS ?? "").trim().length > 0;
            const canAutoCommitSentinel =
                (runtimeChainType === "evm" && hasSentinelKey) ||
                (runtimeChainType === "starknet" && hasSentinelKey && hasSentinelAccount);
            const draftWindowElapsed = Number.isFinite(lockAtMs) && nowMs >= lockAtMs;

            if (lineups.length === 0 && canAutoCommitSentinel) {
                await startAutomationJob("transition-lock", ["run", "job:transition", "--", "lock"]);
                return;
            }

            if (lineups.length === 0 && draftWindowElapsed) {
                if (isReactiveMode) {
                    await haltAutomation("Reactive lock transition missed deadline (no committed strategy in draft window)", {
                        weekId: current.id,
                        status,
                        lockAt: current.lock_at,
                        nowMs,
                        reason: "no-committed-strategy",
                    });
                }
                return;
            }
        if (draftWindowElapsed) {
            await startAutomationJob("transition-lock", ["run", "job:transition", "--", "lock"]);
            return;
        }
            if (isReactiveMode)
                return;
            return;
        }
        if (status === "LOCKED") {
            const startBaselineMs = Number.isFinite(startAtMs) ? startAtMs : lockAtMs;
            if (Number.isFinite(startBaselineMs) && nowMs < startBaselineMs) {
                return;
            }
            await startAutomationJob("transition-start", ["run", "job:transition", "--", "start"]);
            return;
        }
        if (status === "ACTIVE") {
            if (Number.isFinite(endAtMs) && nowMs >= endAtMs) {
                await startAutomationJob("finalize", ["run", "job:finalize"]);
                return;
            }
            if (isReactiveMode)
                return;
            return;
        }
        if (status === "FINALIZE_PENDING") {
            const shouldAutoAudit = automation.mode === "CRON" || (automation.mode === "REACTIVE" && AUTOMATION_REACTIVE_AUTO_AUDIT);
            if (shouldAutoAudit) {
                await startAutomationJob("finalize-audit", ["run", "job:finalize-audit"]);
            }
            return;
        }
        if (status === "FINALIZED") {
            const baselineMs = Number.isFinite(finalizedAtMs) ? finalizedAtMs : endAtMs;
            if (!Number.isFinite(baselineMs)) {
                server.log.warn({ weekId: current.id, status, finalizedAt: current.finalized_at, endAt: current.end_at }, "FINALIZED week missing cooldown baseline; forcing run-week");
                await startAutomationJob("run-week", ["run", "job:week"]);
                return;
            }
            const cooldownEndMs = baselineMs + COOLDOWN_MS;
            if (nowMs >= cooldownEndMs) {
                await startAutomationJob("run-week", ["run", "job:week"]);
            }
        }
    }
    catch (error) {
        server.log.error({ err: error }, "runAutomationTick failed");
    }
    finally {
        automationTickRunning = false;
    }
};
setInterval(() => {
    void runAutomationTick();
}, AUTOMATION_TICK_MS);
void runAutomationTick();

const MOMENTUM_INTERVAL_MS = 4 * 60 * 60 * 1000;
const runAutoMomentum = async () => {
    if (hasRunningJob())
        return;
    const weeks = await getWeeks();
    const current = weeks[0];
    if (!current || current.status === "FINALIZED" || current.status === "FINALIZE_PENDING")
        return;
    await startJob("momentum-live", "node", ["dist/jobs/run-momentum-live.js"]);
};
setInterval(() => {
    void runAutoMomentum().catch((error) => {
        server.log.error({ error }, "runAutoMomentum failed");
    });
}, MOMENTUM_INTERVAL_MS);

let showcaseTickRunning = false;
const runAutoShowcase = async () => {
    if (showcaseTickRunning)
        return;
    showcaseTickRunning = true;
    try {
        const weeks = await getWeeks();
        const current = weeks[0];
        if (!current || current.status !== "ACTIVE") {
            return;
        }
        await buildShowcaseLineup(current.id);
    }
    catch (error) {
        server.log.error({ error }, "runAutoShowcase failed");
    }
    finally {
        showcaseTickRunning = false;
    }
};

setInterval(() => {
    void runAutoShowcase();
}, SHOWCASE_REFRESH_MS);
void runAutoShowcase();
startSelfHealWorker();
void runSelfHealSweep().catch((error) => {
    server.log.error({ error }, "runSelfHealSweep bootstrap failed");
});
setInterval(() => {
    void (async () => {
        const expired = await expireStalePreparedLineupTxIntents(PREPARED_INTENT_EXPIRE_SECONDS);
        if (Array.isArray(expired) && expired.length > 0) {
            server.log.warn({ count: expired.length }, "expired stale prepared lineup intents");
        }
    })().catch((error) => {
        server.log.error({ error }, "expireStalePreparedLineupTxIntents failed");
    });
}, PREPARED_INTENT_SWEEP_MS);
const MOCK_SCORE_SNAPSHOT_INTERVAL_MS = Math.max(600000, Number(env.MOCK_SCORE_SNAPSHOT_INTERVAL_MS || "600000") || 600000);
let mockScoreSnapshotTickRunning = false;
const runMockScoreSnapshotTick = async () => {
    if (hasRunningJob())
        return;
    if (mockScoreSnapshotTickRunning)
        return;
    mockScoreSnapshotTickRunning = true;
    try {
        await captureActiveWeekMockLineupScoreSnapshot();
    }
    catch (error) {
        server.log.error({ error }, "runMockScoreSnapshotTick failed");
    }
    finally {
        mockScoreSnapshotTickRunning = false;
    }
};
setInterval(() => {
    void runMockScoreSnapshotTick();
}, MOCK_SCORE_SNAPSHOT_INTERVAL_MS);
void runMockScoreSnapshotTick();
const port = Number(env.ORACLE_PORT || process.env.PORT || "3101");
server.listen({ port, host: "0.0.0.0" });



































