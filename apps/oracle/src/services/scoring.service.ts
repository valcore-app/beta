/**
 * Weekly Scoring & Reward Distribution Service
 */

import { DbWeeklyResult, DbLineupPosition, queryRead, withWriteTransaction } from "../db/db.js";
import { getLineups } from "../store.js";
import { getLineupPositions } from "./weekPricing.service.js";

const PLATFORM_FEE_RATE = 0.05;
const TOTAL_BUDGET = 100000;
const BUDGET_ALPHA = 0.4;
const BUDGET_CAP = 1.3;
const BUDGET_MIN_RATIO = 0.1;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const computeBudgetMultiplier = (totalSalaryUsed: number) => {
  if (!Number.isFinite(totalSalaryUsed) || totalSalaryUsed <= 0) return 1;
  const unusedRatio = clamp((TOTAL_BUDGET - totalSalaryUsed) / TOTAL_BUDGET, 0, 1);
  const effectiveRatio = clamp(
    (unusedRatio - BUDGET_MIN_RATIO) / (1 - BUDGET_MIN_RATIO),
    0,
    1,
  );
  const raw = 1 + BUDGET_ALPHA * Math.sqrt(effectiveRatio);
  return Math.min(raw, BUDGET_CAP);
};

const ROLE_MULTIPLIERS = {
  core: { pos: 9, neg: -16 },
  stabilizer: { pos: 5, neg: -7 },
  amplifier: { pos: 4, neg: -4 },
  wildcard: { pos: 7, neg: -3 },
} as const;

const getRoleMultiplier = (slotId: string) => {
  const prefix = slotId.split("-")[0]?.toLowerCase();
  if (!prefix) return ROLE_MULTIPLIERS.amplifier;
  if (prefix in ROLE_MULTIPLIERS) {
    return ROLE_MULTIPLIERS[prefix as keyof typeof ROLE_MULTIPLIERS];
  }
  if (prefix === "gk") return ROLE_MULTIPLIERS.core;
  if (prefix === "def") return ROLE_MULTIPLIERS.stabilizer;
  if (prefix === "mid") return ROLE_MULTIPLIERS.amplifier;
  if (prefix === "fwd") return ROLE_MULTIPLIERS.wildcard;
  return ROLE_MULTIPLIERS.amplifier;
};

const calculateSlotScore = (slotId: string, pnlPercent: number): number => {
  const multipliers = getRoleMultiplier(slotId);
  if (pnlPercent >= 0) {
    return pnlPercent * multipliers.pos;
  }
  return Math.abs(pnlPercent) * multipliers.neg;
};

const calculateLineupScore = async (
  lineupId: string,
): Promise<{
  rawPerformance: number;
  efficiencyMultiplier: number;
  finalScore: number;
}> => {
  const positions = await getLineupPositions(lineupId);

  if (positions.length === 0) {
    return { rawPerformance: 0, efficiencyMultiplier: 1, finalScore: 0 };
  }

  const slotSegments = new Map<string, DbLineupPosition[]>();
  for (const position of positions) {
    const list = slotSegments.get(position.slot_id) ?? [];
    list.push(position);
    slotSegments.set(position.slot_id, list);
  }

  const slotSalary = new Map<string, number>();
  const slotScore = new Map<string, number>();

  for (const [slotId, segments] of slotSegments.entries()) {
    const sorted = [...segments].sort((a, b) => {
      const ta = Number(a.start_timestamp ?? 0);
      const tb = Number(b.start_timestamp ?? 0);
      if (ta !== tb) return ta - tb;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    });

    const salary = Number(sorted[0]?.salary_used ?? 0);
    if (!Number.isFinite(salary) || salary <= 0) {
      continue;
    }

    let factor = 1;
    let used = false;

    for (const segment of sorted) {
      const startPrice = Number(segment.start_price ?? 0);
      const endPrice = Number(segment.end_price ?? 0);
      if (!Number.isFinite(startPrice) || startPrice <= 0) {
        continue;
      }
      if (!Number.isFinite(endPrice) || endPrice <= 0) {
        throw new Error(`Position ${segment.id} has no end_price`);
      }
      factor *= endPrice / startPrice;
      used = true;
    }

    if (!used) continue;

    const pnlPercent = (factor - 1) * 100;
    slotSalary.set(slotId, salary);
    slotScore.set(slotId, calculateSlotScore(slotId, pnlPercent));
  }

  const totalSalaryUsed = Array.from(slotSalary.values()).reduce((sum, value) => sum + value, 0);

  if (!totalSalaryUsed) {
    return { rawPerformance: 0, efficiencyMultiplier: 1, finalScore: 0 };
  }

  let totalWeightedScore = 0;

  for (const [slotId, score] of slotScore.entries()) {
    const salary = slotSalary.get(slotId) ?? 0;
    if (salary <= 0) continue;
    const weight = salary / totalSalaryUsed;
    totalWeightedScore += score * weight;
  }

  const rawPerformance = totalWeightedScore;
  const budgetMultiplier = computeBudgetMultiplier(totalSalaryUsed);
  const efficiencyMultiplier = rawPerformance > 0 ? budgetMultiplier : 1;
  const finalScore = rawPerformance * efficiencyMultiplier;

  return { rawPerformance, efficiencyMultiplier, finalScore };
};

export const calculateWeekResults = async (weekId: string): Promise<void> => {
  const lineups = await getLineups(weekId);

  if (lineups.length === 0) {
    return;
  }

  const lineupScores: Array<{
    lineupId: string;
    address: string;
    entryAmount: bigint;
    rawPerformance: number;
    efficiencyMultiplier: number;
    finalScore: number;
  }> = [];

  for (const lineup of lineups) {
    const lineupId = `${weekId}-${lineup.address}`;
    const score = await calculateLineupScore(lineupId);

    lineupScores.push({
      lineupId,
      address: lineup.address,
      entryAmount: BigInt(lineup.deposit_wei),
      ...score,
    });
  }

  const totalPool = lineupScores.reduce(
    (sum, lineup) => sum + lineup.entryAmount,
    0n,
  );
  const feeAmount = (totalPool * BigInt(Math.floor(PLATFORM_FEE_RATE * 10000))) / 10000n;
  const distributablePool = totalPool - feeAmount;

  const winners = lineupScores.filter((lineup) => lineup.finalScore > 0);
  const totalWinnerWeight = winners.reduce((sum, winner) => sum + winner.finalScore, 0);

  const results = lineupScores.map((lineup) => {
    let rewardAmount = 0n;

    if (lineup.finalScore > 0 && totalWinnerWeight > 0) {
      const winnerWeight = lineup.finalScore;
      const share = winnerWeight / totalWinnerWeight;
      rewardAmount = BigInt(Math.floor(Number(distributablePool) * share));
    }

    return {
      lineupId: lineup.lineupId,
      address: lineup.address,
      rawPerformance: lineup.rawPerformance,
      efficiencyMultiplier: lineup.efficiencyMultiplier,
      finalScore: lineup.finalScore,
      rewardAmount,
    };
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

    for (const result of results) {
      await client.query(stmt, [
        weekId,
        result.lineupId,
        result.address,
        result.rawPerformance,
        result.efficiencyMultiplier,
        result.finalScore,
        result.rewardAmount.toString(),
      ]);
    }
  });
};

export const getLeaderboard = async (weekId: string): Promise<DbWeeklyResult[]> => {
  return queryRead<DbWeeklyResult>(
    `
      SELECT * FROM weekly_results
      WHERE week_id = $1
      ORDER BY final_score DESC
    `,
    [weekId],
  );
};

export const getLineupResult = async (
  weekId: string,
  lineupId: string,
): Promise<DbWeeklyResult | undefined> => {
  const rows = await queryRead<DbWeeklyResult>(
    `
      SELECT * FROM weekly_results
      WHERE week_id = $1 AND lineup_id = $2
    `,
    [weekId, lineupId],
  );
  return rows[0];
};

