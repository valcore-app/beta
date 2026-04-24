import { env } from "../env.js";
import { getCoins, getLineups, getWeekCoins, getWeeks, updateWeekStatus, countCompletedLifecycleIntents } from "../store.js";
import {
  finalizeActivePositionsAtWeekEnd,
  getLineupPositions,
  getWeeklyCoinPrices,
  snapshotWeekStartPrices,
  snapshotWeekEndPrices,
} from "../services/weekPricing.service.js";
import {
  calculateLineupWeekScore,
  computeBenchmarkPnlPercent,
} from "../services/weekScore.service.js";
import { withWriteTransaction } from "../db/db.js";
import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { resolveDataDir } from "../paths.js";
import { z } from "zod";
import { getDerivedTimeMode, isManualAutomationMode, normalizeAutomationMode } from "../admin/automation.js";
import {
  getRequiredRuntimeValcoreAddress,
  getRuntimeChainIdBigInt,
  getConfiguredRuntimeChainIdBigInt,
  getRuntimeChainConfig,
  getRuntimeValcoreAddress,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";
import { getOnchainFeeBps, getOnchainTestMode, getOnchainWeekState, sendFinalizeOnchain } from "../network/valcore-chain-client.js";

const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE);
const derivedTimeMode = getDerivedTimeMode(automationMode);
const isManual = isManualAutomationMode(automationMode);

const LineupSlotsSchema = z.array(
  z.object({
    slotId: z.string(),
    coinId: z.string(),
  }),
);

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
  if (String(week.status ?? "").toUpperCase() !== "ACTIVE") {
    throw new Error(`Finalize requires ACTIVE week; got ${String(week.status ?? "UNKNOWN")}`);
  }

  const chainEnabled = isValcoreChainEnabled();
  const endTimestamp = Math.floor(Date.now() / 1000);

  let weeklyPrices = await getWeeklyCoinPrices(week.id);
  if (!weeklyPrices.length) {
    const lockAtTs = Math.floor(new Date(week.lock_at).getTime() / 1000);
    if (Number.isFinite(lockAtTs) && lockAtTs > 0) {
      await snapshotWeekStartPrices(week.id, { timestamp: lockAtTs });
      weeklyPrices = await getWeeklyCoinPrices(week.id);
    }
    if (!weeklyPrices.length) {
      throw new Error("Missing weekly coin prices");
    }
  }

  const hasStartPrices = weeklyPrices.some((row) => row.start_price !== null);
  if (!hasStartPrices) {
    const lockAtTs = Math.floor(new Date(week.lock_at).getTime() / 1000);
    if (Number.isFinite(lockAtTs) && lockAtTs > 0) {
      await snapshotWeekStartPrices(week.id, { timestamp: lockAtTs });
      weeklyPrices = await getWeeklyCoinPrices(week.id);
    }
    const hasRecoveredStartPrices = weeklyPrices.some((row) => row.start_price !== null);
    if (!hasRecoveredStartPrices) {
      throw new Error("Missing week start prices");
    }
  }

  const hasEndPrices = weeklyPrices.some((row) => row.end_price !== null);
  if (!hasEndPrices) {
    await snapshotWeekEndPrices(week.id, { timestamp: endTimestamp });
    weeklyPrices = await getWeeklyCoinPrices(week.id);
  }

  await finalizeActivePositionsAtWeekEnd(week.id);

  const startPriceBySymbol = new Map(
    weeklyPrices
      .filter((row) => row.start_price !== null)
      .map((row) => [row.symbol.toUpperCase(), Number(row.start_price)]),
  );
  const endPriceBySymbol = new Map(
    weeklyPrices
      .filter((row) => row.end_price !== null)
      .map((row) => [row.symbol.toUpperCase(), Number(row.end_price)]),
  );

  if (!startPriceBySymbol.size || !endPriceBySymbol.size) {
    throw new Error("Missing start or end prices");
  }

  const lineups = await getLineups(week.id);
  if (!lineups.length) {
    throw new Error("No lineups found for finalize");
  }

  const coins = await getCoins();
  const weekCoins = await getWeekCoins(week.id);
  const coinById = new Map(coins.map((coin) => [coin.id, coin]));
  const weekCoinById = new Map(weekCoins.map((row) => [row.coin_id, row]));

  const universeSymbols = weekCoins
    .map((weekCoin) => coinById.get(weekCoin.coin_id)?.symbol?.toUpperCase() ?? "")
    .filter(Boolean);

  const benchmarkPnlPercent = computeBenchmarkPnlPercent(
    universeSymbols,
    startPriceBySymbol,
    endPriceBySymbol,
  );

  const scoredLineups: Array<{
    address: string;
    principalWei: bigint;
    riskWei: bigint;
    rawPerformance: number;
    efficiencyMultiplier: number;
    finalScore: number;
  }> = [];

  for (const lineup of lineups) {
    let slotsRaw: unknown;
    try {
      slotsRaw = JSON.parse(lineup.slots_json);
    } catch {
      throw new Error(`Invalid slots_json for lineup ${lineup.address}`);
    }
    const slots = LineupSlotsSchema.parse(slotsRaw);
    const lineupId = `${week.id}-${lineup.address}`;
    const lineupPositions = await getLineupPositions(lineupId);

    const score = calculateLineupWeekScore({
      slots,
      lineupPositions,
      coinById,
      weekCoinById,
      startPriceBySymbol,
      markPriceBySymbol: endPriceBySymbol,
      benchmarkPnlPercent,
    });

    scoredLineups.push({
      address: lineup.address,
      principalWei: BigInt(lineup.principal_wei),
      riskWei: BigInt(lineup.risk_wei),
      rawPerformance: score.rawPerformance,
      efficiencyMultiplier: score.efficiencyMultiplier,
      finalScore: score.finalScore,
    });
  }

  const configuredFeeBps = Number(env.PROTOCOL_FEE_BPS);
  let feeBpsInt = Number.isFinite(configuredFeeBps)
    ? Math.max(0, Math.floor(configuredFeeBps))
    : 0;
  const leagueAddress = chainEnabled ? await getRuntimeValcoreAddress() : null;
  if (leagueAddress) {
    try {
      const onchainFeeBps = await getOnchainFeeBps(leagueAddress);
      if (Number.isFinite(onchainFeeBps) && onchainFeeBps >= 0 && onchainFeeBps <= 10_000) {
        feeBpsInt = Math.floor(onchainFeeBps);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("finalize: failed to read feeBps from chain, falling back to env. " + message);
    }
  }

  const riskTotalWei = scoredLineups.reduce((sum, row) => sum + row.riskWei, 0n);
  const losersRiskTotalWei = scoredLineups
    .filter((row) => row.finalScore < 0)
    .reduce((sum, row) => sum + row.riskWei, 0n);

  const SCORE_SCALE = 1_000_000_000n;
  const winners = scoredLineups
    .filter((row) => row.finalScore > 0)
    .map((row) => ({
      address: row.address,
      weight: BigInt(Math.round(row.finalScore * Number(SCORE_SCALE))),
    }))
    .filter((row) => row.weight > 0n);

  const winnerWeightByAddress = new Map(winners.map((row) => [row.address.toLowerCase(), row.weight]));
  const weightTotal = winners.reduce((sum, row) => sum + row.weight, 0n);
  const primaryWinnerAddress = winners
    .slice()
    .sort((a, b) => {
      if (a.weight === b.weight) {
        return a.address.toLowerCase().localeCompare(b.address.toLowerCase());
      }
      return a.weight > b.weight ? -1 : 1;
    })[0]?.address.toLowerCase();

  const applyCompetition = losersRiskTotalWei > 0n && weightTotal > 0n;
  const feeWei = applyCompetition
    ? (losersRiskTotalWei * BigInt(feeBpsInt)) / 10_000n
    : 0n;
  const rewardPoolWei = losersRiskTotalWei - feeWei;

  const claimDrafts = scoredLineups.map((row) => {
    const weight = winnerWeightByAddress.get(row.address.toLowerCase()) ?? 0n;
    const bonusWei = applyCompetition && weight > 0n
      ? (rewardPoolWei * weight) / weightTotal
      : 0n;

    // Winners and neutral lineups keep their own risk; losers lose their risk.
    // If there are no winners, fallback to full risk refund for all to avoid trapped funds.
    const baseRiskReturnWei = row.finalScore >= 0 || !applyCompetition ? row.riskWei : 0n;
    const riskPayoutWei = baseRiskReturnWei + bonusWei;
    const totalWithdrawWei = row.principalWei + riskPayoutWei;

    return {
      address: row.address,
      principalWei: row.principalWei,
      riskPayoutWei,
      totalWithdrawWei,
      rewardAmountWei: bonusWei,
      rawPerformance: row.rawPerformance,
      efficiencyMultiplier: row.efficiencyMultiplier,
      score: row.finalScore,
    };
  });

  let totalBonusWei = claimDrafts.reduce((sum, row) => sum + row.rewardAmountWei, 0n);
  if (applyCompetition && primaryWinnerAddress) {
    const remainderWei = rewardPoolWei - totalBonusWei;
    if (remainderWei > 0n) {
      const index = claimDrafts.findIndex(
        (row) => row.address.toLowerCase() === primaryWinnerAddress,
      );
      if (index >= 0) {
        claimDrafts[index].rewardAmountWei += remainderWei;
        claimDrafts[index].riskPayoutWei += remainderWei;
        claimDrafts[index].totalWithdrawWei += remainderWei;
        totalBonusWei += remainderWei;
      }
    }
  }

  const claims = claimDrafts.map((row) => ({
    address: row.address,
    principal: row.principalWei.toString(),
    riskPayout: row.riskPayoutWei.toString(),
    totalWithdraw: row.totalWithdrawWei.toString(),
    rewardAmount: row.rewardAmountWei.toString(),
    rawPerformance: row.rawPerformance,
    efficiencyMultiplier: row.efficiencyMultiplier,
    score: row.score,
  }));

  const contractAddress = await getRequiredRuntimeValcoreAddress();
  const chainId = chainEnabled
    ? await getRuntimeChainIdBigInt()
    : await getConfiguredRuntimeChainIdBigInt();
  const weekId = BigInt(week.id);
  const leaves = claims.map((entry) =>
    ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256", "uint256", "uint256"],
      [
        contractAddress,
        chainId,
        weekId,
        entry.address,
        BigInt(entry.principal),
        BigInt(entry.riskPayout),
        BigInt(entry.totalWithdraw),
      ],
    ),
  );

  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  const claimsWithProof = claims.map((entry, idx) => {
    const leaf = leaves[idx];
    const proof = tree.getHexProof(leaf);
    return { ...entry, proof };
  });

  await withWriteTransaction(async (client) => {
    const stmt = `
      INSERT INTO weekly_results (
        week_id, lineup_id, address,
        raw_performance, efficiency_multiplier, final_score,
        reward_amount_wei, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, now()::text)
      ON CONFLICT(week_id, lineup_id) DO UPDATE SET
        raw_performance = EXCLUDED.raw_performance,
        efficiency_multiplier = EXCLUDED.efficiency_multiplier,
        final_score = EXCLUDED.final_score,
        reward_amount_wei = EXCLUDED.reward_amount_wei
    `;

    for (const entry of claimsWithProof) {
      const lineupId = `${week.id}-${entry.address.toLowerCase()}`;
      await client.query(stmt, [
        week.id,
        lineupId,
        entry.address.toLowerCase(),
        entry.rawPerformance,
        entry.efficiencyMultiplier,
        entry.score,
        entry.rewardAmount,
      ]);
    }
  });

  const metadata = {
    weekId: week.id,
    generatedAt: new Date().toISOString(),
    feeBps: feeBpsInt,
    benchmarkPnlPercent,
    riskTotalWei: riskTotalWei.toString(),
    losersRiskTotalWei: losersRiskTotalWei.toString(),
    rewardPoolWei: rewardPoolWei.toString(),
    distributedRewardWei: totalBonusWei.toString(),
    retainedFeeWei: feeWei.toString(),
    distributionMode: applyCompetition ? "losers_pool_weighted" : "risk_refund_fallback",
    weightTotalScaled: weightTotal.toString(),
    root,
  };

  const metadataJson = JSON.stringify(metadata, null, 2);
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson));

  const outDir = resolveDataDir();
  writeFileSync(resolve(outDir, `claims-${week.id}.json`), JSON.stringify(claimsWithProof, null, 2));
  writeFileSync(resolve(outDir, `metadata-${week.id}.json`), metadataJson);

  const finalizeRound = await countCompletedLifecycleIntents(String(week.id), "finalize");
  const opKey = `week:${week.id}:finalize:r${finalizeRound}`;
  let intent = await ensureLifecycleIntent({
    opKey,
    weekId: String(week.id),
    operation: "finalize",
    details: {
      round: finalizeRound,
      root,
      metadataHash,
      feeWei: feeWei.toString(),
      status: "FINALIZE_PENDING",
    },
  });
  if (String(intent.status ?? "").toLowerCase() === "completed") {
    console.log(`finalize skipped: lifecycle intent already completed for week ${week.id}`);
    return;
  }

  const chainType = (await getRuntimeChainConfig()).chainType;
  const isReactiveEvm = chainType === "evm" && String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase() === "REACTIVE";
  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
  let reactiveTxHash: string | null = isReactiveEvm ? txHash : null;

  // If a previous finalize intent is stale while on-chain is still ACTIVE (3),
  // clear stale hash and allow this run to submit a fresh reactive finalize dispatch.
  if (txHash && chainEnabled && leagueAddress) {
    const intentState = String(intent.status ?? "").toLowerCase();
    const onchainNow = await getOnchainWeekState(leagueAddress, weekId);
    const onchainNowStatus = Number(onchainNow.status ?? 0);
    if (onchainNowStatus === 3) {
      const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
      const reactiveStallGraceMs = Math.max(
        15_000,
        Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000,
      );
      const staleSubmitted = pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs;
      if (intentState === "failed" || intentState === "error" || staleSubmitted) {
        if (staleSubmitted) {
          console.warn(
            `[run-finalize] stale reactive finalize callback detected for week ${week.id}; resubmitting with fresh intent tx`,
          );
        }
        txHash = null;
        reactiveTxHash = null;
      }
    }
  }

  try {
    if (!txHash && leagueAddress) {
      const onchainTestMode = await getOnchainTestMode(leagueAddress);
      const useForce = isManual || onchainTestMode;
      if (Boolean(onchainTestMode) !== isManual) {
        console.warn(
          `finalize: AUTOMATION_MODE=${automationMode} (derived ${derivedTimeMode}) but contract testMode=${String(onchainTestMode)}; using ${
            useForce ? "forceFinalizeWeek" : "finalizeWeek"
          }`,
        );
      }

      try {
        txHash = await sendFinalizeOnchain(
          leagueAddress,
          weekId,
          root,
          metadataHash,
          feeWei,
          useForce,
          opKey,
        );
        if (isReactiveEvm) reactiveTxHash = txHash;

        intent =
          (await markLifecycleIntentSubmitted(intent, txHash, {
            txHash,
            root,
            metadataHash,
            feeWei: feeWei.toString(),
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
              root,
              metadataHash,
              feeWei: feeWei.toString(),
              chainExecuted: true,
              reactiveTxHash,
              pendingConfirmation: true,
            })) ?? intent;
          console.log(
            `[run-finalize] reactive finalize submitted tx=${dispatchedReactiveTx}; waiting callback confirmation`,
          );
          return;
        }
        throw error;
      }
    }

    if (chainEnabled && leagueAddress) {
      const onchainAfter = await getOnchainWeekState(leagueAddress, weekId);
      const onchainAfterStatus = Number(onchainAfter.status ?? 0);
      if (onchainAfterStatus !== 4) {
        if (isReactiveEvm && txHash) {
          const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
          const reactiveStallGraceMs = Math.max(
            15_000,
            Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000,
          );
          if (pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs) {
            throw new Error(
              `DETERMINISTIC: finalize reactive callback timeout for week ${week.id}; tx=${txHash}; on-chain status=${onchainAfterStatus}`,
            );
          }
          console.log(
            `[run-finalize] reactive callback pending for week ${week.id}; current on-chain status=${onchainAfterStatus}`,
          );
          return;
        }
        throw new Error(
          `run-finalize: on-chain status is ${onchainAfterStatus}, expected 4 (FINALIZE_PENDING) before DB update`,
        );
      }
    }

    await updateWeekStatus(week.id, "FINALIZE_PENDING");

    await markLifecycleIntentCompleted(intent, {
      txHash,
      root,
      metadataHash,
      feeWei: feeWei.toString(),
      status: "FINALIZE_PENDING",
      chainExecuted: Boolean(txHash),
      reactiveTxHash,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      root,
      metadataHash,
      feeWei: feeWei.toString(),
      status: "FINALIZE_PENDING",
      chainExecuted: Boolean(txHash),
      reactiveTxHash,
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("finalize job failed", error);
  process.exit(1);
});







