import { env } from "../env.js";
import {
  clearAllMockLineups,
  clearMockScoreAggregates,
  countCompletedLifecycleIntents,
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
import { assertWeekChainSync } from "./week-sync-guard.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const action = args[0];
const automationMode = normalizeAutomationMode(env.AUTOMATION_MODE);
const derivedTimeMode = getDerivedTimeMode(automationMode);
const isManual = isManualAutomationMode(automationMode);
const START_WEEK_MOCK_LINEUP_COUNT = Math.max(
  1,
  Math.min(100, Number(env.START_WEEK_MOCK_LINEUP_COUNT ?? "100") || 100),
);

const NO_COMMITTED_HINTS = [
  "nocommittedstrategies",
  "cannot lock week without at least one committed strategy",
  "on-chain committed risk is zero",
  "0xf2b65590",
  "no committed strategies",
];

const DRAFT_CLOSED_HINTS = [
  "draftclosed",
  "0x70fe87b1",
];

const normalizeError = (error: unknown) =>
  String(error instanceof Error ? error.message : error ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9x]/g, "");

const isNoCommittedStrategiesError = (error: unknown) => {
  const normalized = normalizeError(error);
  return NO_COMMITTED_HINTS.some((hint) => normalized.includes(hint.replace(/[^a-z0-9x]/g, "")));
};

const isDraftClosedError = (error: unknown) => {
  const normalized = normalizeError(error);
  return DRAFT_CLOSED_HINTS.some((hint) => normalized.includes(hint.replace(/[^a-z0-9x]/g, "")));
};

const run = async () => {
  if (!action || !["lock", "start"].includes(action)) {
    throw new Error("Usage: run-transition.ts <lock|start>");
  }

  const weeks = await getWeeks();
  const week = weeks[0];
  if (!week) throw new Error("No week found");

  const requiredDbStatus = action === "lock" ? "DRAFT_OPEN" : "LOCKED";
  if (String(week.status ?? "").toUpperCase() !== requiredDbStatus) {
    throw new Error(`transition(${action}) requires ${requiredDbStatus} week; got ${String(week.status ?? "UNKNOWN")}`);
  }

  const chainEnabled = isValcoreChainEnabled();
  const chainConfig = chainEnabled ? await getRuntimeChainConfig().catch(() => null) : null;
  const runtimeChainType = String(chainConfig?.chainType ?? "").toLowerCase();
  const supportsSentinelAutoCommit = runtimeChainType === "evm";
  const leagueAddress = chainEnabled ? await getRuntimeValcoreAddress() : null;

  if (action === "lock") {
    let lineups = await getLineups(week.id);
    if (lineups.length === 0 && !isManual && supportsSentinelAutoCommit) {
      try {
        const sentinelResult = await ensureSentinelLineupForWeek(String(week.id));
        if (sentinelResult.executed) {
          console.log(`transition(lock): sentinel lineup committed address=${sentinelResult.address} tx=${sentinelResult.txHash}`);
        } else {
          console.warn(`transition(lock): sentinel lineup skipped reason=${sentinelResult.reason}`);
        }
        lineups = await getLineups(week.id);
      } catch (error) {
        if (!isManual && isDraftClosedError(error)) {
          console.warn("transition(lock): stale DRAFT_OPEN with closed draft window and no committed strategy; marking week FINALIZED for recovery");
          await updateWeekStatus(week.id, "FINALIZED");
          return;
        }
        throw error;
      }
    }

    if (lineups.length === 0) {
      if (isManual) {
        throw new Error("DETERMINISTIC: cannot lock week without at least one committed strategy");
      }
      if (supportsSentinelAutoCommit) {
        console.warn("transition(lock): no committed strategy yet; skipping this tick and retrying next automation tick");
        return;
      }
      console.warn("transition(lock): no committed strategy yet on non-EVM profile; attempting on-chain lock directly");
    }
  }

  const fallbackTimestamp = Math.floor(new Date(week.lock_at).getTime() / 1000);

  if (chainEnabled && leagueAddress) {
    await assertWeekChainSync({
      context: `run-transition/${action}`,
      leagueAddress,
      weekId: week.id,
      dbStatus: String(week.status ?? ""),
      expectedOnchainStatus: action === "lock" ? 1 : 2,
    });
  }

  if (action === "lock" && chainEnabled && leagueAddress && supportsSentinelAutoCommit) {
    let onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(week.id));
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

      onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(week.id));
      if (Number(onchainWeek.status ?? 0) !== 1 || BigInt(onchainWeek.riskCommitted ?? 0n) <= 0n) {
        console.warn("transition(lock): on-chain committed risk still zero; skipping this tick and retrying next automation tick");
        return;
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
    console.log(`transition(${action}) skipped: lifecycle intent already completed`);
    return;
  }

  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;

  try {
    if (!txHash && leagueAddress) {
      const onchainTestMode = await getOnchainTestMode(leagueAddress);
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
        );

      try {
        txHash = await sendTransition();
      } catch (error) {
        if (action === "lock" && !isManual && supportsSentinelAutoCommit && isNoCommittedStrategiesError(error)) {
          const sentinelResult = await ensureSentinelLineupForWeek(String(week.id));
          if (sentinelResult.executed) {
            console.log(`transition(lock): retried with sentinel heal tx=${sentinelResult.txHash}`);
          } else {
            console.warn(`transition(lock): sentinel retry skipped reason=${sentinelResult.reason}`);
          }

          const refreshed = await getOnchainWeekState(leagueAddress, BigInt(week.id));
          if (Number(refreshed.status ?? 0) !== 1 || BigInt(refreshed.riskCommitted ?? 0n) <= 0n) {
            console.warn("transition(lock): retry skipped because on-chain committed risk is still zero; next automation tick will retry");
            return;
          }

          txHash = await sendTransition();
        } else {
          throw error;
        }
      }

      intent =
        (await markLifecycleIntentSubmitted(intent, txHash, {
          txHash,
          chainExecuted: true,
        })) ?? intent;
    }

    if (action === "lock") {
      await snapshotWeekStartPrices(week.id, {
        txHash,
        timestamp: txHash ? null : fallbackTimestamp,
      });
    }

    if (action === "start") {
      await clearMockScoreAggregates();
      await clearAllMockLineups();
      await generateMockLineups(week.id, START_WEEK_MOCK_LINEUP_COUNT);
      await captureMockLineupScoreSnapshot(week.id);
    }

    await updateWeekStatus(week.id, status);

    await markLifecycleIntentCompleted(intent, {
      txHash,
      status,
      chainExecuted: Boolean(txHash),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      status,
      chainExecuted: Boolean(txHash),
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("Transition job failed:", error);
  process.exit(1);
});