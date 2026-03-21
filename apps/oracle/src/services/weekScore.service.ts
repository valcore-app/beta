import { DbCoin, DbLineupPosition, DbWeekCoin } from "../db/db.js";

export type RoleMultiplier = {
  pos: number;
  neg: number;
};

export type RoleMultiplierSet = {
  core: RoleMultiplier;
  stabilizer: RoleMultiplier;
  amplifier: RoleMultiplier;
  wildcard: RoleMultiplier;
};

export type WeekScoreModelKey =
  | "model_a"
  | "model_s1"
  | "model_s2"
  | "model_s3"
  | "model_s4"
  | "model_s5"
  | "model_s6"
  | "model_s7"
  | "model_s8"
  | "model_s9"
  | "model_s10";

export type WeekScoreModelProfile = {
  key: WeekScoreModelKey;
  label: string;
  alphaDeadZonePercent: number;
  multipliers: RoleMultiplierSet;
  strictnessRank: number;
};

const MODEL_A_MULTIPLIERS: RoleMultiplierSet = {
  core: { pos: 9, neg: -16 },
  stabilizer: { pos: 5, neg: -7 },
  amplifier: { pos: 4, neg: -4 },
  wildcard: { pos: 7, neg: -3 },
};

const CANDIDATE_MODEL_PROFILES: WeekScoreModelProfile[] = [
  {
    key: "model_s1",
    label: "S1 - Tight",
    alphaDeadZonePercent: 0.08,
    strictnessRank: 1,
    multipliers: {
      core: { pos: 8.6, neg: -17.1 },
      stabilizer: { pos: 4.6, neg: -8.0 },
      amplifier: { pos: 3.7, neg: -4.8 },
      wildcard: { pos: 6.2, neg: -3.8 },
    },
  },
  {
    key: "model_s2",
    label: "S2 - Tight",
    alphaDeadZonePercent: 0.07,
    strictnessRank: 2,
    multipliers: {
      core: { pos: 8.7, neg: -16.8 },
      stabilizer: { pos: 4.7, neg: -7.8 },
      amplifier: { pos: 3.8, neg: -4.6 },
      wildcard: { pos: 6.3, neg: -3.6 },
    },
  },
  {
    key: "model_s3",
    label: "S3 - Tight Mid",
    alphaDeadZonePercent: 0.06,
    strictnessRank: 3,
    multipliers: {
      core: { pos: 8.8, neg: -16.6 },
      stabilizer: { pos: 4.8, neg: -7.6 },
      amplifier: { pos: 3.9, neg: -4.5 },
      wildcard: { pos: 6.5, neg: -3.5 },
    },
  },
  {
    key: "model_s4",
    label: "S4 - Tight Mid",
    alphaDeadZonePercent: 0.05,
    strictnessRank: 4,
    multipliers: {
      core: { pos: 8.9, neg: -16.3 },
      stabilizer: { pos: 4.9, neg: -7.4 },
      amplifier: { pos: 4.0, neg: -4.3 },
      wildcard: { pos: 6.6, neg: -3.4 },
    },
  },
  {
    key: "model_s5",
    label: "S5 - Balanced Tight",
    alphaDeadZonePercent: 0.04,
    strictnessRank: 5,
    multipliers: {
      core: { pos: 9.0, neg: -16.0 },
      stabilizer: { pos: 5.0, neg: -7.1 },
      amplifier: { pos: 4.1, neg: -4.1 },
      wildcard: { pos: 6.8, neg: -3.2 },
    },
  },
  {
    key: "model_s6",
    label: "S6 - Balanced",
    alphaDeadZonePercent: 0.03,
    strictnessRank: 6,
    multipliers: {
      core: { pos: 9.1, neg: -15.6 },
      stabilizer: { pos: 5.1, neg: -6.9 },
      amplifier: { pos: 4.2, neg: -3.9 },
      wildcard: { pos: 7.0, neg: -3.0 },
    },
  },
  {
    key: "model_s7",
    label: "S7 - Balanced Loose",
    alphaDeadZonePercent: 0.02,
    strictnessRank: 7,
    multipliers: {
      core: { pos: 9.3, neg: -15.2 },
      stabilizer: { pos: 5.3, neg: -6.6 },
      amplifier: { pos: 4.4, neg: -3.7 },
      wildcard: { pos: 7.2, neg: -2.8 },
    },
  },
  {
    key: "model_s8",
    label: "S8 - Loose Mid",
    alphaDeadZonePercent: 0.01,
    strictnessRank: 8,
    multipliers: {
      core: { pos: 9.5, neg: -14.7 },
      stabilizer: { pos: 5.5, neg: -6.2 },
      amplifier: { pos: 4.6, neg: -3.4 },
      wildcard: { pos: 7.5, neg: -2.6 },
    },
  },
  {
    key: "model_s9",
    label: "S9 - Loose",
    alphaDeadZonePercent: 0,
    strictnessRank: 9,
    multipliers: {
      core: { pos: 9.8, neg: -14.0 },
      stabilizer: { pos: 5.8, neg: -5.8 },
      amplifier: { pos: 4.8, neg: -3.1 },
      wildcard: { pos: 7.8, neg: -2.3 },
    },
  },
  {
    key: "model_s10",
    label: "S10 - Loose",
    alphaDeadZonePercent: 0,
    strictnessRank: 10,
    multipliers: {
      core: { pos: 10.1, neg: -13.2 },
      stabilizer: { pos: 6.1, neg: -5.3 },
      amplifier: { pos: 5.1, neg: -2.9 },
      wildcard: { pos: 8.2, neg: -2.1 },
    },
  },
];

const WEEK_SCORE_BASELINE_MODEL: WeekScoreModelProfile = {
  key: "model_a",
  label: "Model A - Baseline",
  alphaDeadZonePercent: 0,
  multipliers: MODEL_A_MULTIPLIERS,
  strictnessRank: 0,
};

export const WEEK_SCORE_CANDIDATE_KEYS = CANDIDATE_MODEL_PROFILES.map(
  (model) => model.key,
) as WeekScoreModelKey[];

export const WEEK_SCORE_MODEL_ORDER: WeekScoreModelKey[] = [
  "model_a",
  ...WEEK_SCORE_CANDIDATE_KEYS,
];

export const WEEK_SCORE_MODELS: Record<WeekScoreModelKey, WeekScoreModelProfile> = {
  model_a: WEEK_SCORE_BASELINE_MODEL,
  model_s1: CANDIDATE_MODEL_PROFILES[0],
  model_s2: CANDIDATE_MODEL_PROFILES[1],
  model_s3: CANDIDATE_MODEL_PROFILES[2],
  model_s4: CANDIDATE_MODEL_PROFILES[3],
  model_s5: CANDIDATE_MODEL_PROFILES[4],
  model_s6: CANDIDATE_MODEL_PROFILES[5],
  model_s7: CANDIDATE_MODEL_PROFILES[6],
  model_s8: CANDIDATE_MODEL_PROFILES[7],
  model_s9: CANDIDATE_MODEL_PROFILES[8],
  model_s10: CANDIDATE_MODEL_PROFILES[9],
};

const TOTAL_BUDGET = 100000;
const BUDGET_ALPHA = 0.4;
const BUDGET_CAP = 1.3;
const BUDGET_MIN_RATIO = 0.1;

type LineupSlot = {
  slotId: string;
  coinId: string;
};

type CalculateLineupWeekScoreParams = {
  slots: LineupSlot[];
  lineupPositions: DbLineupPosition[];
  coinById: Map<string, DbCoin>;
  weekCoinById: Map<string, DbWeekCoin>;
  startPriceBySymbol: Map<string, number>;
  markPriceBySymbol: Map<string, number>;
  benchmarkPnlPercent: number;
  modelKey?: WeekScoreModelKey;
};

export type LineupWeekScore = {
  rawPerformance: number;
  efficiencyMultiplier: number;
  finalScore: number;
  totalSalaryUsed: number;
  positions: number;
  benchmarkPnlPercent: number;
  lineupPnlPercent: number;
  lineupAlphaPercent: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const computeBudgetMultiplier = (totalSalaryUsed: number) => {
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

export const isWeekScoreModelKey = (value?: string | null): value is WeekScoreModelKey => {
  if (!value) return false;
  return value in WEEK_SCORE_MODELS;
};

export const getWeekScoreModel = (modelKey: WeekScoreModelKey = "model_a") =>
  WEEK_SCORE_MODELS[modelKey] ?? WEEK_SCORE_MODELS.model_a;

export const getWeekScoreModelCatalog = () =>
  WEEK_SCORE_MODEL_ORDER.map((modelKey) => getWeekScoreModel(modelKey));

const getRoleMultiplier = (slotId: string, multipliers: RoleMultiplierSet) => {
  const prefix = slotId.split("-")[0]?.toLowerCase();
  if (!prefix) return multipliers.amplifier;
  if (prefix in multipliers) {
    return multipliers[prefix as keyof RoleMultiplierSet];
  }
  if (prefix === "gk") return multipliers.core;
  if (prefix === "def") return multipliers.stabilizer;
  if (prefix === "mid") return multipliers.amplifier;
  if (prefix === "fwd") return multipliers.wildcard;
  return multipliers.amplifier;
};

const safeMean = (values: number[]) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const computeBenchmarkPnlPercent = (
  universeSymbols: string[],
  startPriceBySymbol: Map<string, number>,
  markPriceBySymbol: Map<string, number>,
) => {
  const pnlValues: number[] = [];

  for (const symbolRaw of universeSymbols) {
    const symbol = symbolRaw.toUpperCase();
    const startPrice = Number(startPriceBySymbol.get(symbol) ?? 0);
    const markPrice = Number(markPriceBySymbol.get(symbol) ?? 0);
    if (!Number.isFinite(startPrice) || startPrice <= 0) continue;
    if (!Number.isFinite(markPrice) || markPrice <= 0) continue;
    pnlValues.push(((markPrice - startPrice) / startPrice) * 100);
  }

  if (!pnlValues.length) return 0;

  const sorted = [...pnlValues].sort((a, b) => a - b);
  const n = sorted.length;
  const k = n < 40 ? 0 : Math.floor(n * 0.05);
  const trimmed = k > 0 ? sorted.slice(k, n - k) : sorted;
  return safeMean(trimmed.length ? trimmed : sorted);
};

export const calculateLineupWeekScoreForModel = ({
  slots,
  lineupPositions,
  coinById,
  weekCoinById,
  startPriceBySymbol,
  markPriceBySymbol,
  benchmarkPnlPercent,
  modelKey = "model_a",
}: CalculateLineupWeekScoreParams): LineupWeekScore => {
  const model = getWeekScoreModel(modelKey);
  const positionsBySlot = new Map<string, DbLineupPosition[]>();
  for (const position of lineupPositions) {
    const list = positionsBySlot.get(position.slot_id) ?? [];
    list.push(position);
    positionsBySlot.set(position.slot_id, list);
  }

  const swappedSlotIds = new Set(positionsBySlot.keys());
  const slotSalaryById = new Map<string, number>();
  const slotPnlPercentById = new Map<string, number>();

  for (const [slotId, segments] of positionsBySlot.entries()) {
    const sorted = [...segments].sort((a, b) => {
      const startDelta = Number(a.start_timestamp ?? 0) - Number(b.start_timestamp ?? 0);
      if (startDelta !== 0) return startDelta;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    });

    const salary = Number(sorted[0]?.salary_used ?? 0);
    if (Number.isFinite(salary) && salary > 0) {
      slotSalaryById.set(slotId, salary);
    }

    let factor = 1;
    let usedAnySegment = false;

    for (const segment of sorted) {
      const startPrice = Number(segment.start_price ?? 0);
      if (!Number.isFinite(startPrice) || startPrice <= 0) continue;

      let endPrice = Number(segment.end_price ?? 0);
      if (!Number.isFinite(endPrice) || endPrice <= 0) {
        endPrice = Number(markPriceBySymbol.get(segment.symbol.toUpperCase()) ?? 0);
      }
      if (!Number.isFinite(endPrice) || endPrice <= 0) continue;

      factor *= endPrice / startPrice;
      usedAnySegment = true;
    }

    if (usedAnySegment) {
      slotPnlPercentById.set(slotId, (factor - 1) * 100);
    }
  }

  for (const slot of slots) {
    if (!slot.coinId || swappedSlotIds.has(slot.slotId)) continue;
    const coin = coinById.get(slot.coinId);
    const symbol = coin?.symbol?.toUpperCase();
    if (!symbol) continue;

    const startPrice = Number(startPriceBySymbol.get(symbol) ?? 0);
    const markPrice = Number(markPriceBySymbol.get(symbol) ?? 0);
    if (!Number.isFinite(startPrice) || startPrice <= 0) continue;
    if (!Number.isFinite(markPrice) || markPrice <= 0) continue;

    const weekCoin = weekCoinById.get(slot.coinId);
    const salary = Number(weekCoin?.salary ?? 0);
    if (Number.isFinite(salary) && salary > 0) {
      slotSalaryById.set(slot.slotId, salary);
    }

    slotPnlPercentById.set(slot.slotId, ((markPrice - startPrice) / startPrice) * 100);
  }

  const totalSalaryUsed = Array.from(slotSalaryById.values()).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalSalaryUsed) || totalSalaryUsed <= 0) {
    return {
      rawPerformance: 0,
      efficiencyMultiplier: 1,
      finalScore: 0,
      totalSalaryUsed: 0,
      positions: 0,
      benchmarkPnlPercent,
      lineupPnlPercent: 0,
      lineupAlphaPercent: 0,
    };
  }

  let rawPerformance = 0;
  let lineupPnlPercent = 0;
  let scoredSlots = 0;

  for (const [slotId, salary] of slotSalaryById.entries()) {
    const slotPnlPercent = slotPnlPercentById.get(slotId);
    if (slotPnlPercent === undefined || !Number.isFinite(slotPnlPercent)) continue;

    const alphaPercent = slotPnlPercent - benchmarkPnlPercent;
    const effectiveAlphaPercent =
      alphaPercent > model.alphaDeadZonePercent
        ? alphaPercent - model.alphaDeadZonePercent
        : alphaPercent > 0
          ? 0
          : alphaPercent;
    const multipliers = getRoleMultiplier(slotId, model.multipliers);
    const positionScore =
      effectiveAlphaPercent >= 0
        ? effectiveAlphaPercent * multipliers.pos
        : Math.abs(effectiveAlphaPercent) * multipliers.neg;

    const weight = salary / totalSalaryUsed;
    rawPerformance += positionScore * weight;
    lineupPnlPercent += slotPnlPercent * weight;
    scoredSlots += 1;
  }

  const efficiencyMultiplier = rawPerformance > 0 ? computeBudgetMultiplier(totalSalaryUsed) : 1;
  const finalScore = rawPerformance * efficiencyMultiplier;

  return {
    rawPerformance,
    efficiencyMultiplier,
    finalScore,
    totalSalaryUsed,
    positions: scoredSlots,
    benchmarkPnlPercent,
    lineupPnlPercent,
    lineupAlphaPercent: lineupPnlPercent - benchmarkPnlPercent,
  };
};

export const calculateLineupWeekScore = (
  params: Omit<CalculateLineupWeekScoreParams, "modelKey">,
): LineupWeekScore => calculateLineupWeekScoreForModel({ ...params, modelKey: "model_a" });