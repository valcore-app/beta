import { getWeeks, updateWeekStatus, countCompletedLifecycleIntents } from "../store.js";
import {
  getRequiredRuntimeValcoreAddress,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import {
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

  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
  let setTestModeTxHash: string | null = null;
  let setTestModeApplied = false;
  let setTestModeError: string | null = null;

  try {
    if (chainEnabled && leagueAddress) {
      if (!txHash) {
        txHash = await sendRejectFinalizationOnchain(leagueAddress, weekId);
        intent =
          (await markLifecycleIntentSubmitted(intent, txHash, {
            txHash,
            chainExecuted: true,
          })) ?? intent;
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
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("finalize-reject job failed", error);
  process.exit(1);
});

