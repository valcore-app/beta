import { env } from "../env.js";
import {
  clearAllMockLineups,
  clearMockScoreAggregates,
  countCompletedLifecycleIntents,
  getWeekById,
  getWeeks,
  getLineups,
  updateWeekStatus,
} from "../store.js";
import { captureMockLineupScoreSnapshot, generateMockLineups } from "../services/mockLineup.service.js";
import { ensureSentinelLineupForWeek } from "../services/sentinelLineup.service.js";
import { snapshotWeekStartPrices } from "../services/weekPricing.service.js";
import { getDerivedTimeMode, isManualAutomationMode, normalizeAutomationMode } from "../admin/automation.js";
import {
  getRuntimeChainConfig,
  getRuntimeValcoreAddress,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { getOnchainTestMode, getOnchainWeekState, sendTransitionOnchain } from "../network/valcore-chain-client.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";
import { queryWrite } from "../db/db.js";
import { reconcileWeekStatusDrift } from "./week-drift.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const action = args[0];
const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE);
const derivedTimeMode = getDerivedTimeMode(automationMode);
const isManual = isManualAutomationMode(automationMode);
const START_WEEK_MOCK_LINEUP_COUNT = Math.max(
  1,
  Math.min(100, Number(env.START_WEEK_MOCK_LINEUP_COUNT ?? "100") || 100),
);
const ONCHAIN_READ_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.ONCHAIN_READ_TIMEOUT_MS ?? "15000") || 15000,
);
const ONCHAIN_READ_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.ONCHAIN_READ_RETRY_ATTEMPTS ?? "3") || 3,
);
const ONCHAIN_READ_RETRY_DELAY_MS = Math.max(
  250,
  Number(process.env.ONCHAIN_READ_RETRY_DELAY_MS ?? "1200") || 1200,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};

const readOnchainWeekState = async (leagueAddress: string, weekId: bigint, context: string) => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= ONCHAIN_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await withTimeout(
        getOnchainWeekState(leagueAddress, weekId),
        ONCHAIN_READ_TIMEOUT_MS,
        `${context}: getOnchainWeekState`,
      );
    } catch (error) {
      lastError = error;
      if (attempt < ONCHAIN_READ_RETRY_ATTEMPTS) {
        await sleep(ONCHAIN_READ_RETRY_DELAY_MS);
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new Error(`${context}: getOnchainWeekState failed after ${ONCHAIN_READ_RETRY_ATTEMPTS} attempt(s): ${message}`);
};

const readOnchainTestMode = async (leagueAddress: string, context: string) => {
  return await withTimeout(
    getOnchainTestMode(leagueAddress),
    ONCHAIN_READ_TIMEOUT_MS,
    `${context}: getOnchainTestMode`,
  );
};

const ensureWeekStatusWritten = async (weekId: string, expectedStatus: string, context: string) => {
  const rows = await queryWrite<{ status: string }>("SELECT status FROM weeks WHERE id = $1", [weekId]);
  const actualStatus = String(rows[0]?.status ?? "").toUpperCase();
  if (actualStatus !== expectedStatus) {
    throw new Error(
      `DETERMINISTIC: ${context} expected DB status=${expectedStatus} but found ${actualStatus || "UNKNOWN"} for week ${weekId}`
    );
  }
};

const NO_COMMITTED_HINTS = [
  "nocommittedstrategies",
  "cannot lock week without at least one committed strategy",
  "on-chain committed risk is zero",
  "0xf2b65590",
  "no committed strategies",
];

const normalizeError = (error: unknown) =>
  String(error instanceof Error ? error.message : error ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9x]/g, "");

const isNoCommittedStrategiesError = (error: unknown) => {
  const normalized = normalizeError(error);
  return NO_COMMITTED_HINTS.some((hint) => normalized.includes(hint.replace(/[^a-z0-9x]/g, "")));
};

const extractReactiveTxHash = (error: unknown): string | null => {
  const direct =
    typeof error === "object" && error !== null
      ? String((error as { reactiveTxHash?: unknown }).reactiveTxHash ?? "").trim().toLowerCase()
      : "";
  if (/^0x[0-9a-f]{64}$/u.test(direct)) return direct;
  return null;
};

const getIntentUpdatedAtMs = (intent: { updated_at?: unknown }) => {
  const raw = String(intent.updated_at ?? "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
};


const run = async () => {
  if (!action || !["lock", "start"].includes(action)) {
    throw new Error("Usage: run-transition.ts <lock|start>");
  }

  const weeks = await getWeeks();
  let week = weeks[0];
  if (!week) throw new Error("No week found");

  const chainEnabled = isValcoreChainEnabled();
  const chainConfig = chainEnabled ? await getRuntimeChainConfig().catch(() => null) : null;
  const runtimeChainType = String(chainConfig?.chainType ?? "").toLowerCase();
  const isReactiveEvm = automationMode === "REACTIVE" && runtimeChainType === "evm";
  const supportsSentinelAutoCommit = runtimeChainType === "evm" || runtimeChainType === "starknet";
  const leagueAddress = chainEnabled ? await getRuntimeValcoreAddress() : null;

  const requiredDbStatus = action === "lock" ? "DRAFT_OPEN" : "LOCKED";
  if (chainEnabled && leagueAddress) {
    const drift = await reconcileWeekStatusDrift({
      context: `run-transition/${action}`,
      weekId: week.id,
      dbStatus: String(week.status ?? ""),
      leagueAddress,
    });
    if (drift.reconciled) {
      week = (await getWeekById(String(week.id))) ?? week;
      const refreshedStatus = String(week.status ?? "").toUpperCase();
      if (refreshedStatus !== requiredDbStatus) {
        console.log(
          `transition(${action}) skipped after drift reconcile: week ${week.id} status is ${refreshedStatus} (requires ${requiredDbStatus})`,
        );
        return;
      }
    }
  }

  if (String(week.status ?? "").toUpperCase() !== requiredDbStatus) {
    throw new Error(`transition(${action}) requires ${requiredDbStatus} week; got ${String(week.status ?? "UNKNOWN")}`);
  }

  if (action === "lock") {
    const lockAtMs = Date.parse(String(week.lock_at ?? ""));
    const draftWindowOpen = !Number.isFinite(lockAtMs) || Date.now() < lockAtMs;
    let lineups = await getLineups(week.id);
    if (lineups.length === 0 && supportsSentinelAutoCommit && !isManual) {
      const trySentinelCommit = async () => {
        const sentinelResult = await ensureSentinelLineupForWeek(String(week.id));
        if (sentinelResult.executed) {
          console.log(`transition(lock): sentinel lineup committed address=${sentinelResult.address} tx=${sentinelResult.txHash}`);
        } else {
          console.warn(`transition(lock): sentinel lineup skipped reason=${sentinelResult.reason}`);
        }
      };

      try {
        await trySentinelCommit();
        lineups = await getLineups(week.id);
      } catch (error) {
        throw error;
      }
    }

    if (lineups.length === 0) {
      if (isManual) {
        throw new Error("DETERMINISTIC: cannot lock week without at least one committed strategy");
      }
      if (Number.isFinite(lockAtMs) && Date.now() >= lockAtMs) {
        throw new Error(
          `DETERMINISTIC: draft window elapsed with zero committed strategy for week ${week.id}; manual intervention required`,
        );
      }
      console.warn("transition(lock): no committed strategy yet; skipping this tick and retrying next automation tick");
      return;
    }

    if (!isManual && draftWindowOpen) {
      console.log("transition(lock): sentinel lineup ready; waiting for lock time");
      return;
    }
  }

  const fallbackTimestamp = Math.floor(new Date(week.lock_at).getTime() / 1000);

  const expectedOnchainStatusBefore = action === "lock" ? 1 : 2;
  const expectedOnchainStatusAfter = action === "lock" ? 2 : 3;
  let alreadyTransitionedOnchain = false;

  if (chainEnabled && leagueAddress) {
    const onchainPre = await readOnchainWeekState(leagueAddress, BigInt(week.id), `run-transition/${action}/pre`);
    const onchainStatusPre = Number(onchainPre.status ?? 0);

    if (onchainStatusPre === expectedOnchainStatusAfter) {
      alreadyTransitionedOnchain = true;
      console.warn(
        `transition(${action}): on-chain already at target status ${expectedOnchainStatusAfter}; reconciling DB to ${action === "lock" ? "LOCKED" : "ACTIVE"}`,
      );
    } else if (onchainStatusPre !== expectedOnchainStatusBefore) {
      throw new Error(
        `run-transition/${action}: DB/on-chain week status mismatch for week ${week.id}. DB=${String(week.status ?? "")} expects on-chain=${expectedOnchainStatusBefore}, actual on-chain=${onchainStatusPre}.`,
      );
    }
  }

  if (action === "lock" && chainEnabled && leagueAddress && supportsSentinelAutoCommit && !alreadyTransitionedOnchain) {
    const lockAtMs = Date.parse(String(week.lock_at ?? ""));
    const draftWindowOpen = !Number.isFinite(lockAtMs) || Date.now() < lockAtMs;
    let onchainWeek = await readOnchainWeekState(leagueAddress, BigInt(week.id), "run-transition/lock/risk-precheck");
    if (Number(onchainWeek.status ?? 0) !== 1 || BigInt(onchainWeek.riskCommitted ?? 0n) <= 0n) {
      if (isManual) {
        throw new Error("DETERMINISTIC: cannot lock week because on-chain committed risk is zero");
      }

      const sentinelResult = await ensureSentinelLineupForWeek(String(week.id));
      if (sentinelResult.executed) {
        console.log(`transition(lock): healed on-chain risk with sentinel tx=${sentinelResult.txHash}`);
      } else {
        console.warn(`transition(lock): sentinel on-chain heal skipped reason=${sentinelResult.reason}`);
      }

      onchainWeek = await readOnchainWeekState(
        leagueAddress,
        BigInt(week.id),
        "run-transition/lock/risk-post-sentinel",
      );
      if (Number(onchainWeek.status ?? 0) !== 1 || BigInt(onchainWeek.riskCommitted ?? 0n) <= 0n) {
        if (!draftWindowOpen) {
          throw new Error(
            `DETERMINISTIC: draft window elapsed with zero committed strategy for week ${week.id}; manual intervention required`,
          );
        }
        throw new Error(
          `DETERMINISTIC: cannot lock week ${week.id}; on-chain committed risk is still zero after sentinel heal`,
        );
      }
    }
  }

  const status = action === "lock" ? "LOCKED" : "ACTIVE";
  const operation = `transition:${action}`;
  const transitionRound = await countCompletedLifecycleIntents(String(week.id), operation);
  const opKey = `week:${week.id}:transition:${action}:r${transitionRound}`;
  let intent = await ensureLifecycleIntent({
    opKey,
    weekId: String(week.id),
    operation,
    details: { action, round: transitionRound, targetStatus: status, automationMode, derivedTimeMode, isManual },
  });

  if (String(intent.status ?? "").toLowerCase() === "completed") {
    if (alreadyTransitionedOnchain && String(week.status ?? "").toUpperCase() !== status) {
      await updateWeekStatus(week.id, status);
      await ensureWeekStatusWritten(String(week.id), status, `transition(${action}) completed-intent reconciliation`);
      console.log(`transition(${action}): DB status reconciled to ${status} (completed lifecycle intent)`);
    }
    console.log(`transition(${action}) skipped: lifecycle intent already completed`);
    return;
  }

  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
  let reactiveTxHash: string | null = isReactiveEvm ? txHash : null;

  // If a previous failed attempt left a tx hash but on-chain state did not move,
  // clear the stale hash and retry by submitting a fresh transition tx.
  if (txHash && chainEnabled && leagueAddress && !alreadyTransitionedOnchain) {
    const intentState = String(intent.status ?? "").toLowerCase();
    if (intentState === "failed" || intentState === "error") {
      const onchainNow = await getOnchainWeekState(leagueAddress, BigInt(week.id));
      const onchainNowStatus = Number(onchainNow.status ?? 0);
      if (onchainNowStatus === expectedOnchainStatusBefore) {
        txHash = null;
        reactiveTxHash = null;
      }
    }
  }

  try {
    if (!txHash && leagueAddress && !alreadyTransitionedOnchain) {
      const onchainTestMode = await readOnchainTestMode(leagueAddress, `run-transition/${action}`);
      const useForce = isManual || onchainTestMode;
      if (Boolean(onchainTestMode) !== isManual) {
        console.warn(
          `transition(${action}): AUTOMATION_MODE=${automationMode} (derived ${derivedTimeMode}) but contract testMode=${String(onchainTestMode)}; using ${
            useForce ? "force*" : "timed"
          } transition`,
        );
      }

      const sendTransition = async () =>
        sendTransitionOnchain(
          leagueAddress,
          action as "lock" | "start",
          BigInt(week.id),
          useForce,
          opKey,
        );

      try {
        txHash = await sendTransition();
        if (isReactiveEvm) reactiveTxHash = txHash;
      } catch (error) {
        const dispatchedReactiveTx = extractReactiveTxHash(error);
        if (dispatchedReactiveTx) {
          txHash = dispatchedReactiveTx;
          if (isReactiveEvm) reactiveTxHash = txHash;
          intent =
            (await markLifecycleIntentSubmitted(intent, txHash, {
              txHash,
              chainExecuted: true,
              reactiveTxHash,
              submittedAtMs: Date.now(),
              pendingConfirmation: true,
            })) ?? intent;
          console.log(
            `transition(${action}): reactive tx submitted (${dispatchedReactiveTx}); waiting callback confirmation`,
          );
          return;
        }
        if (action === "lock" && supportsSentinelAutoCommit && isNoCommittedStrategiesError(error)) {
          const sentinelResult = await ensureSentinelLineupForWeek(String(week.id));
          if (sentinelResult.executed) {
            console.log(`transition(lock): retried with sentinel heal tx=${sentinelResult.txHash}`);
          } else {
            console.warn(`transition(lock): sentinel retry skipped reason=${sentinelResult.reason}`);
          }

          const refreshed = await getOnchainWeekState(leagueAddress, BigInt(week.id));
          if (Number(refreshed.status ?? 0) !== 1 || BigInt(refreshed.riskCommitted ?? 0n) <= 0n) {
            throw new Error(
              `DETERMINISTIC: transition(lock) retry failed; on-chain committed risk is still zero for week ${week.id}`,
            );
          }

          txHash = await sendTransition();
          if (isReactiveEvm) reactiveTxHash = txHash;
        } else {
          throw error;
        }
      }

      intent =
        (await markLifecycleIntentSubmitted(intent, txHash, {
          txHash,
          chainExecuted: true,
          reactiveTxHash,
          submittedAtMs: Date.now(),
        })) ?? intent;
    }

    if (chainEnabled && leagueAddress && !alreadyTransitionedOnchain) {
      const onchainAfter = await readOnchainWeekState(leagueAddress, BigInt(week.id), `run-transition/${action}/post`);
      const onchainAfterStatus = Number(onchainAfter.status ?? 0);
      if (onchainAfterStatus !== expectedOnchainStatusAfter) {
        if (isReactiveEvm && txHash) {
          const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
          const reactiveStallGraceMs = Math.max(
            15_000,
            Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000,
          );
          if (pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs) {
            throw new Error(
              `DETERMINISTIC: transition(${action}) reactive callback timeout for week ${week.id}; tx=${txHash}; on-chain status=${onchainAfterStatus}`,
            );
          }
          console.log(
            `transition(${action}): reactive tx submitted (${txHash}); destination status still ${onchainAfterStatus}, waiting for callback confirmation`,
          );
          return;
        }
        throw new Error(
          `transition(${action}): on-chain status is ${onchainAfterStatus}, expected ${expectedOnchainStatusAfter} before DB update`,
        );
      }
    }

    if (action === "lock") {
      const snapshotTxHash = isReactiveEvm ? null : txHash;
      await snapshotWeekStartPrices(week.id, {
        txHash: snapshotTxHash,
        timestamp: snapshotTxHash ? null : fallbackTimestamp,
      });
    }

    if (action === "start") {
      await clearMockScoreAggregates();
      await clearAllMockLineups();
      await generateMockLineups(week.id, START_WEEK_MOCK_LINEUP_COUNT);
      await captureMockLineupScoreSnapshot(week.id);
    }

    await updateWeekStatus(week.id, status);
    await ensureWeekStatusWritten(String(week.id), status, `transition(${action}) post-update`);

    await markLifecycleIntentCompleted(intent, {
      txHash,
      status,
      chainExecuted: Boolean(txHash) || alreadyTransitionedOnchain,
      reactiveTxHash,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      status,
      chainExecuted: Boolean(txHash) || alreadyTransitionedOnchain,
      reactiveTxHash,
    });
    throw error;
  }
};

run().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("Transition job failed:", error);
  process.exit(1);
});



