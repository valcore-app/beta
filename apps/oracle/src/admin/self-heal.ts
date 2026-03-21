import { EventEmitter } from "events";
import { env } from "../env.js";
import {
  claimSelfHealTask,
  getSelfHealSummary,
  getSelfHealTaskById,
  insertSelfHealTaskRun,
  listDueSelfHealTasks,
  listRecentSelfHealTaskRuns,
  listSelfHealTasks,
  markSelfHealTaskCanceled,
  markSelfHealTaskDead,
  markSelfHealTaskRetry,
  markSelfHealTaskSuccess,
  retrySelfHealTaskNow,
  upsertLineup,
  upsertSelfHealTask,
} from "../store.js";
import { applySwapPriceSegment } from "../services/weekPricing.service.js";
import {
  type LineupSyncPayload,
  type LineupSyncSlot,
  verifyLineupSyncPayload,
} from "../services/lineupSync.service.js";

type SelfHealKind = "transient" | "deterministic" | "unknown" | "stopped";

const POLL_MS = Number(env.SELF_HEAL_POLL_MS);
const BATCH_SIZE = Number(env.SELF_HEAL_BATCH_SIZE);
const BASE_MS = Number(env.SELF_HEAL_BASE_MS);
const MAX_MS = Number(env.SELF_HEAL_MAX_MS);
const JITTER_MS = Number(env.SELF_HEAL_JITTER_MS);
const DEFAULT_MAX_ATTEMPTS = Number(env.SELF_HEAL_DEFAULT_MAX_ATTEMPTS);

const TRANSIENT_HINTS = [
  "transient",
  "timeout",
  "timed out",
  "econnreset",
  "socket hang up",
  "connection refused",
  "connection closed",
  "network error",
  "temporary",
  "temporarily unavailable",
  "rate limit",
  "429",
  "502",
  "503",
  "504",
  "gateway",
  "service unavailable",
  "fetch failed",
  "failed to fetch",
  "too many requests",
];

const DETERMINISTIC_HINTS = [
  "deterministic",
  "invalid",
  "required",
  "must",
  "constraint",
  "duplicate key",
  "violates",
  "not null",
  "malformed",
  "bad request",
  "lineup slots",
  "lineup not found",
  "address",
  "week",
  "cannot",
  "unsupported",
  "reverted",
  "mismatch",
];

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]/g, "");

const classifyError = (message: string | null): SelfHealKind => {
  if (!message) return "unknown";
  const normalized = normalize(message);
  if (normalized.includes("stopped") || normalized.includes("canceled")) return "stopped";
  if (DETERMINISTIC_HINTS.some((hint) => normalized.includes(normalize(hint)))) {
    return "deterministic";
  }
  if (TRANSIENT_HINTS.some((hint) => normalized.includes(normalize(hint)))) {
    return "transient";
  }
  return "unknown";
};

const nowIso = () => new Date().toISOString();

const computeDelayMs = (attempt: number, kind: SelfHealKind) => {
  const base = Number.isFinite(BASE_MS) && BASE_MS > 0 ? BASE_MS : 4000;
  const max = Number.isFinite(MAX_MS) && MAX_MS > 0 ? MAX_MS : 120000;
  const jitter = Number.isFinite(JITTER_MS) && JITTER_MS >= 0 ? JITTER_MS : 1200;
  const multiplier = kind === "unknown" ? 2 : 1;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)) * multiplier);
  const noise = Math.floor(Math.random() * (jitter + 1));
  return exp + noise;
};

type PersistedLineupSyncPayload = LineupSyncPayload & {
  weekIdHint?: string;
};

const normalizeSlots = (slots: LineupSyncSlot[]) =>
  slots.map((slot) => ({
    slotId: slot.slotId.trim(),
    coinId: (slot.coinId ?? "").trim(),
  }));

const normalizeLineupPayload = (payload: PersistedLineupSyncPayload): PersistedLineupSyncPayload => {
  const raw = payload as PersistedLineupSyncPayload & {
    weekId?: string;
    swap?: PersistedLineupSyncPayload["swap"] & { swapTxHash?: string };
  };
  const inferredTxHash =
    typeof raw.txHash === "string" && raw.txHash
      ? raw.txHash
      : (typeof raw.swap?.swapTxHash === "string" ? raw.swap.swapTxHash : "");
  if (!inferredTxHash) {
    throw new Error("DETERMINISTIC: txHash is required for lineup sync");
  }

  return {
    txHash: inferredTxHash.toLowerCase(),
    source: raw.source ?? (raw.swap ? "swap" : "commit"),
    weekIdHint: raw.weekIdHint ?? raw.weekId,
    addressHint:
      typeof raw.addressHint === "string" && raw.addressHint.trim()
        ? raw.addressHint.trim().toLowerCase()
        : undefined,
    swap: raw.swap
      ? {
        slotId: raw.swap.slotId.trim(),
        removedSymbol: raw.swap.removedSymbol.toUpperCase(),
        addedSymbol: raw.swap.addedSymbol.toUpperCase(),
      }
      : undefined,
    slots: normalizeSlots(raw.slots ?? []),
  };
};

const syncLineupPayload = async (payload: PersistedLineupSyncPayload) => {
  const normalized = normalizeLineupPayload(payload);
  const verified = await verifyLineupSyncPayload({
    txHash: normalized.txHash,
    weekIdHint: normalized.weekIdHint,
    addressHint: normalized.addressHint,
    source: normalized.source,
    slots: normalized.slots,
    swap: normalized.swap,
  });

  if (!verified.stale && verified.source === "swap" && normalized.swap) {
    await applySwapPriceSegment({
      weekId: verified.weekId,
      lineupId: `${verified.weekId}-${verified.address}`,
      slotId: normalized.swap.slotId,
      removedSymbol: normalized.swap.removedSymbol,
      addedSymbol: normalized.swap.addedSymbol,
      swapTxHash: verified.txHash,
    });
  }

  if (!verified.stale) {
    await upsertLineup({
      week_id: verified.weekId,
      address: verified.address,
      slots_json: JSON.stringify(normalized.slots),
      lineup_hash: verified.lineupHash,
      deposit_wei: verified.depositWei,
      principal_wei: verified.principalWei,
      risk_wei: verified.riskWei,
      swaps: verified.swaps,
      created_at: nowIso(),
    });
  }

  return verified;
};

const buildLineupSyncKey = (payload: PersistedLineupSyncPayload) => {
  const source = payload.source ?? "commit";
  return `lineup_sync:${source}:${payload.txHash.toLowerCase()}`;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;

export const selfHealEvents = new EventEmitter();
selfHealEvents.setMaxListeners(50);

const emitTaskUpdate = async (taskId: number) => {
  const task = await getSelfHealTaskById(taskId);
  selfHealEvents.emit("task:update", {
    taskId,
    status: task?.status ?? null,
    task,
  });
};

const processTaskById = async (taskId: number) => {
  const startedAt = nowIso();
  const claimed = await claimSelfHealTask(taskId, startedAt);
  if (!claimed) return null;

  const attempt = claimed.attempt_count;
  let runStatus = "error";
  let runError: string | null = null;
  let runCode: string | null = null;

  try {
    if (claimed.task_type !== "lineup_sync") {
      throw new Error(`Unsupported task type: ${claimed.task_type}`);
    }

    const payload = JSON.parse(claimed.payload_json) as PersistedLineupSyncPayload;
    const verified = await syncLineupPayload(payload);

    await markSelfHealTaskSuccess(taskId);
    runStatus = "success";
    await insertSelfHealTaskRun({
      task_id: taskId,
      attempt,
      status: runStatus,
      error_message: verified.stale ? "Stale task ignored" : null,
      error_code: verified.stale ? "stale" : null,
      started_at: startedAt,
      finished_at: nowIso(),
    });
    await emitTaskUpdate(taskId);
    return { taskId, status: "success" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown self-heal failure";
    const kind = classifyError(message);
    const maxAttempts = Number.isFinite(claimed.max_attempts) && claimed.max_attempts > 0
      ? claimed.max_attempts
      : (Number.isFinite(DEFAULT_MAX_ATTEMPTS) && DEFAULT_MAX_ATTEMPTS > 0 ? DEFAULT_MAX_ATTEMPTS : 12);

    runError = message;
    runCode = kind;

    const canRetry = kind !== "deterministic" && kind !== "stopped" && attempt < maxAttempts;
    if (canRetry) {
      const delay = computeDelayMs(attempt, kind);
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      await markSelfHealTaskRetry(taskId, nextAttemptAt, message, kind);
      runStatus = "retrying";
    } else {
      await markSelfHealTaskDead(taskId, message, kind);
      runStatus = kind === "stopped" ? "canceled" : "dead";
    }

    await insertSelfHealTaskRun({
      task_id: taskId,
      attempt,
      status: runStatus,
      error_message: runError,
      error_code: runCode,
      started_at: startedAt,
      finished_at: nowIso(),
    });

    await emitTaskUpdate(taskId);
    return { taskId, status: runStatus as "retrying" | "dead" | "canceled" };
  }
};

export const runSelfHealSweep = async () => {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const now = nowIso();
    const limit = Number.isFinite(BATCH_SIZE) && BATCH_SIZE > 0 ? BATCH_SIZE : 5;
    const tasks = await listDueSelfHealTasks(limit, now);
    for (const task of tasks) {
      await processTaskById(Number(task.id));
    }
  } finally {
    sweepRunning = false;
  }
};

export const startSelfHealWorker = () => {
  if (pollTimer) return;
  const interval = Number.isFinite(POLL_MS) && POLL_MS > 0 ? POLL_MS : 5000;
  pollTimer = setInterval(() => {
    void runSelfHealSweep().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[self-heal] sweep failed: ${message}`);
    });
  }, interval);
};

export const stopSelfHealWorker = () => {
  if (!pollTimer) return;
  clearInterval(pollTimer as unknown as number);
  pollTimer = null;
};

export const enqueueLineupSyncTask = async (
  payload: PersistedLineupSyncPayload,
  options?: { maxAttempts?: number },
) => {
  const normalized = normalizeLineupPayload(payload);
  const task = await upsertSelfHealTask({
    task_type: "lineup_sync",
    task_key: buildLineupSyncKey(normalized),
    week_id: normalized.weekIdHint ?? null,
    payload_json: JSON.stringify(normalized),
    max_attempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  });

  if (!task?.id) {
    throw new Error("Failed to queue self-heal task");
  }

  if (task.status !== "success") {
    await processTaskById(Number(task.id));
  }

  const latest = await getSelfHealTaskById(Number(task.id));
  if (!latest) {
    throw new Error("Queued task disappeared");
  }

  return latest;
};

export const cancelSelfHealTaskById = async (taskId: number) => {
  await markSelfHealTaskCanceled(taskId);
  await insertSelfHealTaskRun({
    task_id: taskId,
    attempt: 0,
    status: "canceled",
    error_message: "Canceled by operator",
    error_code: "stopped",
    started_at: nowIso(),
    finished_at: nowIso(),
  });
  await emitTaskUpdate(taskId);
  return getSelfHealTaskById(taskId);
};

export const retrySelfHealTaskById = async (taskId: number) => {
  const task = await retrySelfHealTaskNow(taskId);
  if (!task) return null;
  await emitTaskUpdate(taskId);
  await processTaskById(taskId);
  return getSelfHealTaskById(taskId);
};

export const getSelfHealDashboard = async () => {
  const [summary, tasks, runs] = await Promise.all([
    getSelfHealSummary(),
    listSelfHealTasks(120),
    listRecentSelfHealTaskRuns(150),
  ]);
  return { summary, tasks, runs };
};
