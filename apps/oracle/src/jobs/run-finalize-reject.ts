import { env } from "../env.js";
import { getWeeks, updateWeekStatus, countCompletedLifecycleIntents } from "../store.js";
import {
  getRequiredRuntimeValcoreAddress,
  getRuntimeChainConfig,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import {
  getOnchainWeekState,
  getOnchainTestMode,
  sendRejectFinalizationOnchain,
  sendSetTestModeOnchain,
} from "../network/valcore-chain-client.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";

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
  const weeks = await getWeeks();
  const week = weeks[0];
  if (!week) throw new Error("No week found");
  if (String(week.status ?? "").toUpperCase() !== "FINALIZE_PENDING") {
    throw new Error(`Reject requires FINALIZE_PENDING week; got ${String(week.status ?? "UNKNOWN")}`);
  }

  const finalizeRound = Math.max(
    0,
    (await countCompletedLifecycleIntents(String(week.id), "finalize")) - 1,
  );
  const opKey = `week:${week.id}:finalize-reject:r${finalizeRound}`;
  let intent = await ensureLifecycleIntent({
    opKey,
    weekId: String(week.id),
    operation: "finalize-reject",
    details: {
      round: finalizeRound,
      status: "ACTIVE",
      setTestModeAfterReject: true,
    },
  });
  if (String(intent.status ?? "").toLowerCase() === "completed") {
    console.log(`finalize-reject skipped: lifecycle intent already completed for week ${week.id}`);
    return;
  }

  const chainEnabled = isValcoreChainEnabled();
  const weekId = BigInt(week.id);
  const leagueAddress = chainEnabled ? await getRequiredRuntimeValcoreAddress() : null;
  const chainType = (await getRuntimeChainConfig()).chainType;
  const isReactiveEvm = chainType === "evm" && String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase() === "REACTIVE";

  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
  let reactiveTxHash: string | null = isReactiveEvm ? txHash : null;
  let setTestModeTxHash: string | null = null;
  let setTestModeApplied = false;
  let setTestModeError: string | null = null;

  try {
    if (chainEnabled && leagueAddress) {
      if (!txHash) {
        try {
          txHash = await sendRejectFinalizationOnchain(leagueAddress, weekId, opKey);
          if (isReactiveEvm) reactiveTxHash = txHash;
          intent =
            (await markLifecycleIntentSubmitted(intent, txHash, {
              txHash,
              chainExecuted: true,
              reactiveTxHash,
            })) ?? intent;
        } catch (error) {
          const dispatchedReactiveTx = extractReactiveTxHash(error);
          if (isReactiveEvm && dispatchedReactiveTx) {
            txHash = dispatchedReactiveTx;
            reactiveTxHash = dispatchedReactiveTx;
            intent =
              (await markLifecycleIntentSubmitted(intent, dispatchedReactiveTx, {
                txHash: dispatchedReactiveTx,
                chainExecuted: true,
                reactiveTxHash,
                pendingConfirmation: true,
              })) ?? intent;
            console.log(
              `[run-finalize-reject] reactive reject submitted tx=${dispatchedReactiveTx}; waiting callback confirmation`,
            );
            return;
          }
          throw error;
        }
      }

      const postRejectState = await getOnchainWeekState(leagueAddress, weekId);
      const postRejectStatus = Number(postRejectState.status ?? 0);
      if (postRejectStatus !== 3) {
        if (isReactiveEvm && txHash) {
          const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
          const reactiveStallGraceMs = Math.max(
            15_000,
            Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000,
          );
          if (pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs) {
            throw new Error(
              `DETERMINISTIC: finalize-reject reactive callback timeout for week ${week.id}; tx=${txHash}; on-chain status=${postRejectStatus}`,
            );
          }
          console.log(
            `[run-finalize-reject] reactive callback pending for week ${week.id}; current on-chain status=${postRejectStatus}`,
          );
          return;
        }
        throw new Error(
          `run-finalize-reject: on-chain status is ${postRejectStatus}, expected 3 (ACTIVE) before DB update`,
        );
      }

      const testMode = await getOnchainTestMode(leagueAddress);
      if (testMode) {
        setTestModeApplied = true;
      } else {
        try {
          setTestModeTxHash = await sendSetTestModeOnchain(leagueAddress, true);
          setTestModeApplied = true;
        } catch (error) {
          setTestModeError = error instanceof Error ? error.message : String(error);
          console.warn(`finalize-reject: setTestMode(true) failed, continuing. ${setTestModeError}`);
        }
      }
    } else {
      setTestModeApplied = true;
    }

    await updateWeekStatus(week.id, "ACTIVE");

    await markLifecycleIntentCompleted(intent, {
      txHash,
      setTestModeTxHash,
      setTestModeApplied,
      setTestModeError,
      status: "ACTIVE",
      chainExecuted: chainEnabled && Boolean(txHash),
      reactiveTxHash,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      setTestModeTxHash,
      setTestModeApplied,
      setTestModeError,
      status: "ACTIVE",
      chainExecuted: chainEnabled && Boolean(txHash),
      reactiveTxHash,
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("finalize-reject job failed", error);
  process.exit(1);
});


