import { env } from "../env.js";
import { getCoins, getLineups, getWeekCoins, getWeeks, updateWeekStatus, countCompletedLifecycleIntents, syncStrategyEpochScoresForWeek } from "../store.js";
import {
  finalizeActivePositionsAtWeekEnd,
  getLineupPositions,
  getWeeklyCoinPrices,
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
import { getOnchainFeeBps, getOnchainTestMode, sendFinalizeOnchain } from "../network/valcore-chain-client.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";
import { assertWeekChainSync } from "./week-sync-guard.js";

const automationMode = normalizeAutomationMode(env.AUTOMATION_MODE);
const derivedTimeMode = getDerivedTimeMode(automationMode);
const isManual = isManualAutomationMode(automationMode);

const LineupSlotsSchema = z.array(
  z.object({
    slotId: z.string(),
    coinId: z.string(),
  }),
);

const encodeClaimAddressForLeaf = (address: string, chainType: string) => {
  const raw = String(address ?? "").trim();
  if (chainType === "starknet") {
    if (!/^0x[0-9a-fA-F]{1,64}$/u.test(raw)) {
      throw new Error("Invalid Starknet address for finalize leaf: " + String(address ?? ""));
    }
    return ethers.toBeHex(BigInt(raw), 32);
  }
  return ethers.getAddress(raw);
};

const buildFinalizeLeaf = (
  chainType: string,
  contractAddress: string,
  chainId: bigint,
  weekId: bigint,
  address: string,
  principal: bigint,
  riskPayout: bigint,
  totalWithdraw: bigint,
) => {
  if (chainType === "starknet") {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "bytes32", "uint256", "uint256", "uint256"],
      [
        encodeClaimAddressForLeaf(contractAddress, "starknet"),
        chainId,
        weekId,
        encodeClaimAddressForLeaf(address, "starknet"),
        principal,
        riskPayout,
        totalWithdraw,
      ],
    );
  }

  return ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256", "address", "uint256", "uint256", "uint256"],
    [
      encodeClaimAddressForLeaf(contractAddress, "evm"),
      chainId,
      weekId,
      encodeClaimAddressForLeaf(address, "evm"),
      principal,
      riskPayout,
      totalWithdraw,
    ],
  );
};

const normalizeHashForChain = (value: string, chainType: string) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(normalized)) {
    throw new Error("Invalid hash for finalize payload: " + String(value ?? ""));
  }
  if (chainType !== "starknet") {
    return normalized;
  }
  const starknetFieldPrime = BigInt("0x800000000000011000000000000000000000000000000000000000000000001");
  return ethers.toBeHex(BigInt(normalized) % starknetFieldPrime, 32).toLowerCase();
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

  if (chainEnabled) {
    const leagueAddressForGuard = await getRuntimeValcoreAddress();
    if (!leagueAddressForGuard) {
      throw new Error("finalize: VALCORE_ADDRESS is required when chain mode is enabled");
    }
    await assertWeekChainSync({
      context: "run-finalize",
      leagueAddress: leagueAddressForGuard,
      weekId: week.id,
      dbStatus: String(week.status ?? ""),
      expectedOnchainStatus: 3,
    });
  }

  let weeklyPrices = await getWeeklyCoinPrices(week.id);
  if (!weeklyPrices.length) {
    throw new Error("Missing weekly coin prices");
  }

  const hasStartPrices = weeklyPrices.some((row) => row.start_price !== null);
  if (!hasStartPrices) {
    throw new Error("Missing week start prices");
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
  const chainType = (await getRuntimeChainConfig()).chainType;
  const weekId = BigInt(week.id);
  const leaves = claims.map((entry) =>
    buildFinalizeLeaf(
      chainType,
      contractAddress,
      chainId,
      weekId,
      entry.address,
      BigInt(entry.principal),
      BigInt(entry.riskPayout),
      BigInt(entry.totalWithdraw),
    ),
  );

  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();
  const rootForChain = normalizeHashForChain(root, chainType);

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

  await syncStrategyEpochScoresForWeek(String(week.id));

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
    root: rootForChain,
  };

  const metadataJson = JSON.stringify(metadata, null, 2);
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson));
  const metadataHashForChain = normalizeHashForChain(metadataHash, chainType);

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
      root: rootForChain,
      metadataHash: metadataHashForChain,
      feeWei: feeWei.toString(),
      status: "FINALIZE_PENDING",
    },
  });
  if (String(intent.status ?? "").toLowerCase() === "completed") {
    console.log(`finalize skipped: lifecycle intent already completed for week ${week.id}`);
    return;
  }

  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;

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

      txHash = await sendFinalizeOnchain(
        leagueAddress,
        weekId,
        rootForChain,
        metadataHashForChain,
        feeWei,
        useForce,
      );

      intent =
        (await markLifecycleIntentSubmitted(intent, txHash, {
          txHash,
          root: rootForChain,
          metadataHash: metadataHashForChain,
          feeWei: feeWei.toString(),
          chainExecuted: true,
        })) ?? intent;
    }
    await updateWeekStatus(week.id, "FINALIZE_PENDING");

    await markLifecycleIntentCompleted(intent, {
      txHash,
      root: rootForChain,
      metadataHash: metadataHashForChain,
      feeWei: feeWei.toString(),
      status: "FINALIZE_PENDING",
      chainExecuted: Boolean(txHash),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      root: rootForChain,
      metadataHash: metadataHashForChain,
      feeWei: feeWei.toString(),
      status: "FINALIZE_PENDING",
      chainExecuted: Boolean(txHash),
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("finalize job failed", error);
  process.exit(1);
});
