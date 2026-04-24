import { env } from "../env.js";
import {
  setWeekCoins,
  upsertCoin,
  upsertWeek,
  updateWeekStatus,
  getCoins,
  getCoinsByCategory,
  getWeeks,
  getWeekById,
  getWeekCoins,
} from "../store.js";
import { POSITION_RULES, COIN_EXCLUDE_KEYWORDS } from "../constants.js";
import { fetchJsonWithRetry, withConcurrency, sleep } from "../services/api-client.js";
import { computeSnapshotMetrics, type SnapshotMetric } from "../services/metrics-service.js";
import { ensureCoinsDirectory, downloadCoinLogo } from "../services/coin-logo-service.js";
import { getPricesBySymbols } from "../services/priceOracle.service.js";
import { fetchBinanceBaseAssets } from "../services/price-service.js";
import {
  getRuntimeValcoreAddress,
  getRuntimeChainConfig,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { createWeekOnchain, getOnchainWeekState } from "../network/valcore-chain-client.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";
import { assertWeekChainSync, isUnresolvedDbWeekStatus } from "./week-sync-guard.js";

const COINS_ENDPOINT = "/coins/markets";
const STABLECOINS_CATEGORY = "stablecoins"; // CoinGecko category ID
const COINGECKO_RATE_MS = 2500;
const COINGECKO_STABLE_DELAY_MS = 2000;
const COINGECKO_MARKET_RETRY_CONFIG = { maxRetries: 4, backoffMs: 2000, timeoutMs: 12000 } as const;
const COINGECKO_STABLE_RETRY_CONFIG = { maxRetries: 2, backoffMs: 1500, timeoutMs: 8000 } as const;
const SNAPSHOT_METRICS_MAX_ATTEMPTS = 3;
const SNAPSHOT_METRICS_RETRY_DELAY_MS = 7000;

type GeckoCoin = {
  id: string;
  symbol: string;
  name: string;
  market_cap: number;
  market_cap_rank: number;
  current_price: number;
};

/**
 * Check if a coin name matches exclusion keywords
 * Returns true if the coin should be excluded
 */
const matchesExcludeKeywords = (name: string): boolean => {
  const lowerName = name.toLowerCase();

  // Check substring matches
  for (const keyword of COIN_EXCLUDE_KEYWORDS.substrings) {
    if (lowerName.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  // Check whole word matches (word boundaries)
  for (const keyword of COIN_EXCLUDE_KEYWORDS.wholeWords) {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(name)) {
      return true;
    }
  }

  return false;
};

/**
 * Check if a coin is a gold-backed token
 * Gold tokens are NOT stablecoins - they should be in eligible category
 */
const isGoldToken = (name: string, symbol: string): boolean => {
  const lowerName = name.toLowerCase();
  const lowerSymbol = symbol.toLowerCase();

  // Known gold token symbols
  const goldSymbols = ["xaut", "paxg", "gld", "dgld", "pmgt"];
  if (goldSymbols.includes(lowerSymbol)) return true;

  // Check name for gold indicators
  if (lowerName.includes("gold") || lowerName.includes("tether gold")) return true;

  return false;
};

/**
 * Determine the category for a coin
 * @param coin The coin from CoinGecko
 * @param stablecoinIds Set of IDs that are stablecoins (from CoinGecko category)
 */
const determineCoinCategory = (
  coin: GeckoCoin,
  stablecoinIds: Set<string>
): "stablecoin" | "excluded" | "eligible" => {
  // Check if it's in CoinGecko's stablecoins category
  if (stablecoinIds.has(coin.id)) {
    // But gold tokens are NOT stablecoins - they go to eligible
    if (isGoldToken(coin.name, coin.symbol)) {
      return "eligible";
    }
    return "stablecoin";
  }

  // Then check exclusion keywords (wrapped, bridged, staked, etc.)
  if (matchesExcludeKeywords(coin.name)) {
    return "excluded";
  }

  // Otherwise it's eligible for DEF/MID/FWD
  return "eligible";
};

const TOTAL_BUDGET = 100000;
const SALARY_MIN = 2500;
const SALARY_MAX = 15000;
const SALARY_SCALE = 0.85;

const roleWeights: Record<string, number> = {
  GK: 1.1,
  DEF: 1.0,
  MID: 0.8,
  FWD: 0.7,
};

const roleSlotCounts: Record<string, number> = {
  GK: 1,
  DEF: 4,
  MID: 4,
  FWD: 2,
};

const riskWeights: Record<string, number> = {
  Low: 1.05,
  Medium: 1.0,
  High: 0.95,
};

const baseSlotSalary = (() => {
  const sumWeights = Object.entries(roleSlotCounts).reduce((sum, [position, count]) => {
    const weight = roleWeights[position] ?? 1;
    return sum + weight * count;
  }, 0);
  return TOTAL_BUDGET / (sumWeights || 1);
})();

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const computePowerWeightRaw = (power: number) => {
  const powerValue = Number.isFinite(power) ? power : 0;
  const powerNorm = clamp((powerValue - 30) / 70, 0, 1);
  const powerCurve = Math.pow(powerNorm, 1.35);
  return 0.7 + 0.55 * powerCurve;
};

const median = (values: number[]) => {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

// Removed: Using service layer instead (price-service.ts)

const computeSalary = (
  position: string,
  rankIndex: number,
  total: number,
  power: number,
  risk: string,
  medianPowerWeight: number,
) => {
  const roleWeight = roleWeights[position] ?? 1;
  const riskWeight = riskWeights[risk] ?? 1;
  const rankT = total <= 1 ? 0 : rankIndex / (total - 1);
  const rankScore = 1 - rankT;
  const rankWeight = 0.92 + 0.16 * rankScore;
  const powerWeightRaw = computePowerWeightRaw(power);
  const normalizedPowerWeight = clamp(powerWeightRaw / (medianPowerWeight || 1), 0.75, 1.25);
  const powerWeight = normalizedPowerWeight;
  const salary =
    baseSlotSalary * roleWeight * powerWeight * riskWeight * rankWeight * SALARY_SCALE;
  return Math.round(clamp(salary, SALARY_MIN, SALARY_MAX));
};

const hasUsableMetric = (metric: SnapshotMetric | undefined) =>
  Boolean(
    metric &&
    !(
      metric.raw.rawPower === 0 &&
      metric.raw.rawRisk === 0 &&
      metric.raw.rawMomentum === 0
    ),
  );

export type RunWeekOptions = {
  refreshCurrentDraft?: boolean;
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

const assertOnchainDraftWeek = async (input: {
  leagueAddress: string;
  weekId: string;
  startAt: Date;
  lockAt: Date;
  endAt: Date;
  context: string;
}) => {
  const expectedStartAt = Math.floor(input.startAt.getTime() / 1000);
  const expectedLockAt = Math.floor(input.lockAt.getTime() / 1000);
  const expectedEndAt = Math.floor(input.endAt.getTime() / 1000);
  const onchainWeek = await getOnchainWeekState(input.leagueAddress, BigInt(input.weekId));
  const onchainStatus = Number(onchainWeek.status ?? 0);
  const onchainStartAt = Number(onchainWeek.startAt ?? 0n);
  const onchainLockAt = Number(onchainWeek.lockAt ?? 0n);
  const onchainEndAt = Number(onchainWeek.endAt ?? 0n);

  if (
    onchainStatus !== 1 ||
    onchainStartAt !== expectedStartAt ||
    onchainLockAt !== expectedLockAt ||
    onchainEndAt !== expectedEndAt
  ) {
    throw new Error(
      `${input.context}: on-chain week invariant failed for week ${input.weekId}. expected(status=1,start=${expectedStartAt},lock=${expectedLockAt},end=${expectedEndAt}) got(status=${onchainStatus},start=${onchainStartAt},lock=${onchainLockAt},end=${onchainEndAt})`,
    );
  }
};
const getRequiredLeagueAddress = async (context: string): Promise<string> => {
  const leagueAddress = await getRuntimeValcoreAddress();
  if (!leagueAddress) {
    throw new Error(`${context}: VALCORE_ADDRESS is required when chain mode is enabled`);
  }
  return leagueAddress;
};

export const runWeek = async (options: RunWeekOptions = {}) => {
  console.log("[run-week] start", new Date().toISOString());
  const refreshCurrentDraft = Boolean(options.refreshCurrentDraft);
  const weeks = await getWeeks();
  const current = weeks[0];
  const currentStatus = String(current?.status ?? "").toUpperCase();

  let weekId: string;
  let startAt: Date;
  let lockAt: Date;
  let endAt: Date;
  let draftHoursForSchedule = 23;
  let weekDaysForSchedule = 6;
  let scheduleCanSlide = false;

  if (refreshCurrentDraft) {
    if (!current || currentStatus !== "DRAFT_OPEN") {
      throw new Error(`refresh-week-coins requires DRAFT_OPEN current week; got ${currentStatus || "UNKNOWN"}`);
    }
    weekId = String(current.id);
    startAt = new Date(current.start_at);
    lockAt = new Date(current.lock_at);
    endAt = new Date(current.end_at);
  } else if (isUnresolvedDbWeekStatus(currentStatus)) {
    if (isValcoreChainEnabled()) {
      const leagueAddressForGuard = await getRequiredLeagueAddress("run-week/precheck");
      await assertWeekChainSync({
        context: "run-week/precheck",
        leagueAddress: leagueAddressForGuard,
        weekId: String(current?.id ?? ""),
        dbStatus: currentStatus,
      });
    }
    throw new Error(`run-week blocked: unresolved current week status ${currentStatus}`);
  } else if (current && currentStatus === "PREPARING") {
    weekId = String(current.id);
    startAt = new Date(current.start_at);
    lockAt = new Date(current.lock_at);
    endAt = new Date(current.end_at);
  } else {
    // Use UTC-based timestamps (Date.now is UTC epoch milliseconds).
    const baseNowMs = env.RUN_WEEK_BASE_TIME_MS ? Number(env.RUN_WEEK_BASE_TIME_MS) : Date.now();
    const nowMs = Number.isFinite(baseNowMs) ? baseNowMs : Date.now();
    const draftHoursRaw = Number(env.DRAFT_OPEN_HOURS ?? "23");
    const draftHours = Number.isFinite(draftHoursRaw) && draftHoursRaw > 0 ? draftHoursRaw : 23;
    const weekDaysRaw = Number(env.WEEK_DURATION_DAYS);
    const weekDays = Number.isFinite(weekDaysRaw) && weekDaysRaw > 0 ? weekDaysRaw : 6;
    draftHoursForSchedule = draftHours;
    weekDaysForSchedule = weekDays;
    scheduleCanSlide = true;
    lockAt = new Date(nowMs + draftHours * 60 * 60 * 1000);
    startAt = lockAt;
    endAt = new Date(lockAt.getTime() + weekDays * 24 * 60 * 60 * 1000);
    weekId = String(Math.floor(startAt.getTime() / 1000));
  }

  // Fast-path for PREPARING weeks: avoid re-running heavy market/metrics build while
  // waiting for (or reconciling after) reactive create callback.
  if (!refreshCurrentDraft && current && currentStatus === "PREPARING") {
    const chainEnabled = isValcoreChainEnabled();
    const leagueAddress = chainEnabled ? await getRequiredLeagueAddress("run-week/preparing-fastpath") : null;
    const chainType = (await getRuntimeChainConfig()).chainType;
    const isReactiveEvm =
      chainType === "evm" &&
      String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase() === "REACTIVE";
    const opKey = `week:${weekId}:create`;
    const intent = await ensureLifecycleIntent({
      opKey,
      weekId,
      operation: "create-week",
      details: {
        startAt: startAt.toISOString(),
        lockAt: lockAt.toISOString(),
        endAt: endAt.toISOString(),
        targetStatus: "DRAFT_OPEN",
      },
    });
    let txHash = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
    const existingWeekCoins = await getWeekCoins(weekId);
    const ensureDraftDataPresent = () => {
      if (existingWeekCoins.length === 0) {
        throw new Error(
          `DETERMINISTIC: week ${weekId} is PREPARING but week_coins is empty; run-week cannot reconcile`,
        );
      }
    };

    if (txHash && chainEnabled && leagueAddress) {
      const onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(weekId));
      const onchainStatus = Number(onchainWeek.status ?? 0);
      if (onchainStatus === 1) {
        ensureDraftDataPresent();
        await assertOnchainDraftWeek({
          leagueAddress,
          weekId,
          startAt,
          lockAt,
          endAt,
          context: "run-week/preparing-fastpath",
        });
        await updateWeekStatus(weekId, "DRAFT_OPEN");
        await markLifecycleIntentCompleted(intent, {
          txHash,
          status: "DRAFT_OPEN",
          chainExecuted: true,
          reactiveTxHash: isReactiveEvm ? txHash : null,
          startAt: startAt.toISOString(),
          lockAt: lockAt.toISOString(),
          endAt: endAt.toISOString(),
        });
        console.log(`[run-week] fast-path reconciled PREPARING -> DRAFT_OPEN for week ${weekId}`);
        return;
      }
      if (isReactiveEvm) {
        const intentState = String((intent as { status?: unknown }).status ?? "").toLowerCase();
        if ((intentState === "failed" || intentState === "error") && onchainStatus === 0) {
          txHash = null;
        }
        const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
        const reactiveStallGraceMs = Math.max(15_000, Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000);
        if (pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs && onchainStatus === 0) {
          txHash = null;
        }
        if (!txHash) {
          // stale reactive tx hash cleared; continue with normal create flow below
        } else {
          console.log(
            `[run-week] fast-path pending reactive callback for week ${weekId}; tx=${txHash}; on-chain status=${onchainStatus}`,
          );
          return;
        }
      }
      if (txHash) {
        throw new Error(
          `DETERMINISTIC: week ${weekId} create intent submitted but on-chain status is ${onchainStatus} (expected 1)`,
        );
      }
    }
  }

  const geckoHeaders = env.COINGECKO_API_KEY
    ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY }
    : undefined;

  const existingCoins = await getCoins();
  const fallbackRankMap = new Map<string, number>();
  for (const previous of weeks) {
    if (!previous || String(previous.id) === String(weekId)) continue;
    const prevWeekCoins = await getWeekCoins(String(previous.id));
    for (const row of prevWeekCoins) {
      const coinId = String((row as any).coin_id ?? "");
      const rankValue = Number((row as any).rank ?? 0);
      if (!coinId || !Number.isFinite(rankValue) || rankValue <= 0) continue;
      if (!fallbackRankMap.has(coinId)) {
        fallbackRankMap.set(coinId, rankValue);
      }
    }
    if (fallbackRankMap.size > 0) break;
  }

  let marketFetchFailed = false;
  let marketFetchFailureMessage = "";
  const geckoCoins: GeckoCoin[] = [];
  // Fetch top 300 coins by market cap (3 pages x 100 coins)
  for (let page = 1; page <= 3; page++) {
    try {
      console.log(`[run-week] coingecko markets page=${page} start`);
      const pageCoins = await fetchJsonWithRetry<GeckoCoin[]>(
        `${env.COINGECKO_BASE_URL}${COINS_ENDPOINT}?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}&sparkline=false&price_change_percentage=7d`,
        geckoHeaders,
        COINGECKO_MARKET_RETRY_CONFIG,
      );
      geckoCoins.push(...pageCoins);
      console.log(`[run-week] coingecko markets page=${page} done count=${pageCoins.length}`);
    } catch (error) {
      marketFetchFailed = true;
      marketFetchFailureMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[run-week] coingecko markets page=${page} failed: ${marketFetchFailureMessage}`);
      break;
    }

    // Rate limit: wait 2s between requests for free API
    if (page < 3) {
      await sleep(COINGECKO_RATE_MS);
    }
  }

  if (geckoCoins.length === 0) {
    if (fallbackRankMap.size === 0) {
      throw new Error(`CoinGecko market universe unavailable and no fallback rank map present: ${marketFetchFailureMessage || "unknown"}`);
    }
    console.warn(
      `[run-week] coingecko markets unavailable; using fallback rank map from previous week size=${fallbackRankMap.size} error=${marketFetchFailureMessage || "unknown"}`
    );
  } else if (marketFetchFailed) {
    console.warn(
      `[run-week] coingecko markets partially available count=${geckoCoins.length}; filling missing ranks from fallback map size=${fallbackRankMap.size}`
    );
  }

  // Rate limit before next request (stablecoins list)
  await sleep(COINGECKO_STABLE_DELAY_MS);

  console.log("[run-week] coingecko stablecoins fetch start");
  const existingStablecoinIds = new Set(
    existingCoins
      .filter((coin) => String((coin as any).category_id ?? "").toLowerCase() === "stablecoin")
      .map((coin) => String((coin as any).id)),
  );
  let stablecoinIds = new Set(existingStablecoinIds);

  try {
    // Fetch stablecoins category to identify stablecoins
    const stablecoinsList = await fetchJsonWithRetry<GeckoCoin[]>(
      `${env.COINGECKO_BASE_URL}${COINS_ENDPOINT}?vs_currency=usd&category=${STABLECOINS_CATEGORY}&order=market_cap_desc&per_page=100&page=1&sparkline=false`,
      geckoHeaders,
      COINGECKO_STABLE_RETRY_CONFIG,
    );
    stablecoinIds = new Set([...stablecoinIds, ...stablecoinsList.map((c) => c.id)]);
    console.log(`[run-week] coingecko stablecoins fetch done count=${stablecoinsList.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[run-week] coingecko stablecoins fetch failed: ${message}; fallbackStableIds=${existingStablecoinIds.size}`);
    if (stablecoinIds.size === 0) {
      throw new Error(`Stablecoin universe unavailable: ${message}`);
    }
  }

  const nowIso = new Date().toISOString();

  // Ensure public/coins directory exists
  ensureCoinsDirectory();

  const existingCoinIds = new Set(existingCoins.map((c) => c.id));

  // Statistics for logging
  const stats = { eligible: 0, stablecoin: 0, excluded: 0, skipped: 0 };

  console.log("[run-week] process new coins start");
  // Process coins from API with proper categorization
  for (const coin of geckoCoins) {
    const symbol = coin.symbol.toUpperCase();
    // Skip if coin already exists in DB
    if (existingCoinIds.has(coin.id)) {
      stats.skipped++;
      continue;
    }

    // Determine category
    const categoryId = determineCoinCategory(coin, stablecoinIds);
    stats[categoryId]++;

    // Download logo from CoinCap
    const imagePath = await downloadCoinLogo(symbol);

    // Insert coin with determined category
    await upsertCoin({
      id: coin.id,
      symbol,
      name: coin.name,
      category_id: categoryId,
      image_path: imagePath,
      last_updated: nowIso,
    });
  }

  console.log(`[run-week] process new coins done eligible=${stats.eligible} stable=${stats.stablecoin} excluded=${stats.excluded} skipped=${stats.skipped}`);
  // Get coins by category from DB (after processing)
  const eligibleCoins = await getCoinsByCategory("eligible");
  const stableCoins = await getCoinsByCategory("stablecoin");



  // Build rank map from CoinGecko market cap ranks
  const ranked = geckoCoins
    .filter((coin) => coin.market_cap_rank)
    .sort((a, b) => a.market_cap_rank - b.market_cap_rank);
  const rankMap = new Map(ranked.map((c) => [c.id, c.market_cap_rank || 0]));
  for (const [coinId, rank] of fallbackRankMap.entries()) {
    if (!rankMap.has(coinId)) {
      rankMap.set(coinId, rank);
    }
  }
  if (rankMap.size === 0) {
    throw new Error("Rank map is empty; cannot build weekly universe deterministically");
  }


  // Prepare coins for positions - use eligible coins first, then stables for GK
  const eligibleRanked = eligibleCoins
    .map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      rank: rankMap.get(c.id) || 0,
    }))
    .filter((c) => c.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  const stablesRankedAll = stableCoins
    .map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      rank: rankMap.get(c.id) || 0,
    }))
    .filter((c) => c.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  // ========== REDSTONE PRICE CHECK ==========
  // Only coins with valid prices can be assigned to week_coins
  // This is a weekly check, not a permanent categorization

  const allCandidateSymbols = [
    ...eligibleRanked.map((c) => c.symbol),
    ...stablesRankedAll.map((c) => c.symbol),
  ];

  const symbolPriceMap = await getPricesBySymbols(allCandidateSymbols);
  const symbolsWithPrice = new Set(Object.keys(symbolPriceMap));
  const binanceBases = await fetchBinanceBaseAssets();
  const hasBinancePair = (symbol: string) => binanceBases.has(symbol.toUpperCase());

  // Filter out coins without RedStone prices
  const eligibleWithPrice = eligibleRanked.filter((c) => {
    const hasPrice = symbolsWithPrice.has(c.symbol.toUpperCase());
    const hasBinance = hasBinancePair(c.symbol);
    if (!hasPrice) {
      // Exclude coins without RedStone prices
    }
    return hasPrice && hasBinance;
  });

  const stablesRanked = stablesRankedAll.filter((c) => {
    const hasPrice = symbolsWithPrice.has(c.symbol.toUpperCase());
    const hasBinance = hasBinancePair(c.symbol);
    if (!hasPrice) {
      // Exclude coins without RedStone prices
    }
    return hasPrice && hasBinance;
  });

  // ==========================================

  // Filter coins by market-cap rank buckets.
  // IMPORTANT: Do not move coins across role buckets (DEF/MID/FWD).
  // Each role must stay strictly inside its own rank window.
  const filterByRank = (coins: typeof eligibleWithPrice, startRank: number, endRank: number) =>
    coins.filter((c) => c.rank >= startRank && c.rank <= endRank);

  const pools: Record<"GK" | "DEF" | "MID" | "FWD", typeof eligibleWithPrice> = {
    GK: stablesRanked.slice(0, POSITION_RULES.GK.count),
    DEF: filterByRank(eligibleWithPrice, POSITION_RULES.DEF.startRank, POSITION_RULES.DEF.endRank),
    MID: filterByRank(eligibleWithPrice, POSITION_RULES.MID.startRank, POSITION_RULES.MID.endRank),
    FWD: filterByRank(eligibleWithPrice, POSITION_RULES.FWD.startRank, POSITION_RULES.FWD.endRank),
  };
  // Hard minimums required to build at least one valid 11-slot strategy.
  const hardMinByPosition: Record<"GK" | "DEF" | "MID" | "FWD", number> = {
    GK: roleSlotCounts.GK,
    DEF: roleSlotCounts.DEF,
    MID: roleSlotCounts.MID,
    FWD: roleSlotCounts.FWD,
  };

  for (const key of ["GK", "DEF", "MID", "FWD"] as const) {
    pools[key].sort((a, b) => a.rank - b.rank);
  }

  const deficits = (["GK", "DEF", "MID", "FWD"] as const)
    .map((position) => ({
      position,
      need: hardMinByPosition[position],
      have: pools[position].length,
    }))
    .filter((row) => row.have < row.need);

  if (deficits.length) {
    const detail = deficits.map((row) => `${row.position}:${row.have}/${row.need}`).join(",");
    throw new Error(`Week coin universe cannot satisfy minimum formation slots (${detail})`);
  }

  const positions: { position: string; coins: typeof eligibleWithPrice }[] = [
    { position: "GK", coins: pools.GK },
    { position: "DEF", coins: pools.DEF },
    { position: "MID", coins: pools.MID },
    { position: "FWD", coins: pools.FWD },
  ];

  const positionTotals = Object.fromEntries(
    positions.map((block) => [block.position, block.coins.length]),
  ) as Record<string, number>;

  const targetCoins = positions.flatMap((block) =>
    block.coins.map((coin, idx) => ({
      coin,
      position: block.position,
      idx,
      total: positionTotals[block.position] ?? block.coins.length,
    })),
  );
  const metricTargets = Array.from(
    new Map(targetCoins.map(({ coin }) => [coin.id, coin])).values(),
  ).map((coin) => ({ id: coin.id, symbol: coin.symbol }));

  console.log(`[run-week] metrics start targets=${metricTargets.length}`);
  let metricsByCoin = await computeSnapshotMetrics(metricTargets, geckoHeaders, { preferBinance: true });
  console.log("[run-week] metrics initial pass done");
  let missingMetricTargets = metricTargets.filter((coin) => !hasUsableMetric(metricsByCoin[coin.id]));
  const maxRetryableMissing = 24;

  for (
    let attempt = 2;
    attempt <= SNAPSHOT_METRICS_MAX_ATTEMPTS &&
    missingMetricTargets.length > 0 &&
    missingMetricTargets.length <= maxRetryableMissing;
    attempt += 1
  ) {
    console.log(`[run-week] metrics retry attempt=${attempt} missing=${missingMetricTargets.length}`);
    await sleep(SNAPSHOT_METRICS_RETRY_DELAY_MS * (attempt - 1));
    const retryMetrics = await computeSnapshotMetrics(missingMetricTargets, geckoHeaders, { preferBinance: true });
    metricsByCoin = { ...metricsByCoin, ...retryMetrics };
    missingMetricTargets = missingMetricTargets.filter((coin) => !hasUsableMetric(metricsByCoin[coin.id]));
  }

  if (missingMetricTargets.length) {
    const sample = missingMetricTargets
      .slice(0, 20)
      .map((coin) => coin.symbol)
      .join(",");
    console.warn(
      `[run-week] metrics fallback defaults count=${missingMetricTargets.length}/${metricTargets.length} sample=${sample}`,
    );
    for (const missing of missingMetricTargets) {
      metricsByCoin[missing.id] = {
        power: 50,
        risk: "Medium",
        momentum: "Steady",
        raw: {
          rawPower: 0,
          rawRisk: 0,
          rawMomentum: 0,
        },
      };
    }
    missingMetricTargets = [];
  }
  const metricsUpdatedAt = new Date().toISOString();
  const powerWeightsByRole: Record<string, number[]> = {
    GK: [],
    DEF: [],
    MID: [],
    FWD: [],
  };

  for (const { coin, position } of targetCoins) {
    const metric = metricsByCoin[coin.id];
    if (!hasUsableMetric(metric)) {
      throw new Error(`Invariant violation: metrics missing for ${coin.symbol} in ${position}`);
    }
    const rawWeight = computePowerWeightRaw(metric.power);
    if (!Number.isFinite(rawWeight)) continue;
    if (position in powerWeightsByRole) {
      powerWeightsByRole[position].push(rawWeight);
    }
  }

  const medianPowerWeightByRole = Object.fromEntries(
    Object.entries(powerWeightsByRole).map(([role, values]) => [role, median(values)]),
  ) as Record<string, number>;

  console.log(`[run-week] week coin build start targets=${targetCoins.length}`);
  const weekCoins = await withConcurrency(targetCoins, 4, async ({ coin, position, idx, total }) => {
    const metric = metricsByCoin[coin.id];
    if (!hasUsableMetric(metric)) {
      throw new Error(`Invariant violation: metrics missing during week coin build for ${coin.symbol}`);
    }
    const medianPowerWeight = medianPowerWeightByRole[position] ?? 1;
    const salary = computeSalary(position, idx, total, metric.power, metric.risk, medianPowerWeight);
    return {
      week_id: weekId,
      coin_id: coin.id,
      rank: coin.rank,
      position,
      salary,
      power: metric.power,
      risk: metric.risk,
      momentum: metric.momentum,
      momentum_live: metric.momentum,
      metrics_updated_at: metricsUpdatedAt,
      momentum_live_updated_at: metricsUpdatedAt,
    };
  });

  console.log(`[run-week] week coin build done count=${weekCoins.length}`);
  if (weekCoins.length !== targetCoins.length) {
    throw new Error(`Week coin count mismatch: expected=${targetCoins.length} actual=${weekCoins.length}`);
  }

  if (scheduleCanSlide) {
    const nowMs = Date.now();
    const lockLeadSecondsRaw = Number(env.RUN_WEEK_MIN_LOCK_LEAD_SECONDS ?? "90");
    const lockLeadSeconds = Number.isFinite(lockLeadSecondsRaw) && lockLeadSecondsRaw > 0
      ? lockLeadSecondsRaw
      : 90;
    const minLockLeadMs = Math.floor(lockLeadSeconds * 1000);
    const scheduleIsStale = lockAt.getTime() <= nowMs + minLockLeadMs;
    if (scheduleIsStale) {
      const previousWeekId = weekId;
      const draftWindowMs = Math.floor(draftHoursForSchedule * 60 * 60 * 1000);
      const effectiveLockLeadMs = Math.max(draftWindowMs, minLockLeadMs);
      const nextLockAt = new Date(nowMs + effectiveLockLeadMs);
      const nextStartAt = nextLockAt;
      const nextEndAt = new Date(nextLockAt.getTime() + weekDaysForSchedule * 24 * 60 * 60 * 1000);
      const nextWeekId = String(Math.floor(nextStartAt.getTime() / 1000));

      weekId = nextWeekId;
      startAt = nextStartAt;
      lockAt = nextLockAt;
      endAt = nextEndAt;

      if (nextWeekId !== previousWeekId) {
        for (const row of weekCoins) {
          row.week_id = nextWeekId;
        }
      }

      console.warn(
        `[run-week] schedule shifted to future window oldWeekId=${previousWeekId} newWeekId=${nextWeekId} lockAt=${lockAt.toISOString()} minLeadMs=${minLockLeadMs}`
      );
    }
  }

  if (refreshCurrentDraft) {
    if (isValcoreChainEnabled()) {
      const leagueAddress = await getRequiredLeagueAddress("refresh-week-coins");
      await assertOnchainDraftWeek({
        leagueAddress,
        weekId,
        startAt,
        lockAt,
        endAt,
        context: "refresh-week-coins",
      });
    }
    console.log("[run-week] setWeekCoins start");
  await setWeekCoins(weekId, weekCoins);
  console.log("[run-week] setWeekCoins done");
    console.log(`refresh-week-coins completed for week ${weekId} (weekCoins=${weekCoins.length})`);
    return;
  }

  if (!refreshCurrentDraft) {
    await upsertWeek({
      id: weekId,
      start_at: startAt.toISOString(),
      lock_at: lockAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "PREPARING",
    });
  }
  const chainEnabled = isValcoreChainEnabled();
  const leagueAddress = chainEnabled ? await getRequiredLeagueAddress("run-week") : null;
  const chainType = (await getRuntimeChainConfig()).chainType;
  const isReactiveEvm = chainType === "evm" && String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase() === "REACTIVE";
  const opKey = `week:${weekId}:create`;
  let intent = await ensureLifecycleIntent({
    opKey,
    weekId,
    operation: "create-week",
    details: {
      startAt: startAt.toISOString(),
      lockAt: lockAt.toISOString(),
      endAt: endAt.toISOString(),
      targetStatus: "DRAFT_OPEN",
    },
  });
  if (String(intent.status ?? "").toLowerCase() === "completed") {
    if (chainEnabled && leagueAddress) {
      console.log("[run-week] onchain draft assertion start");
      await assertOnchainDraftWeek({
        leagueAddress,
        weekId,
        startAt,
        lockAt,
        endAt,
        context: "run-week/completed-intent",
      });
    }
    if (refreshCurrentDraft && leagueAddress) {
      await assertWeekChainSync({
        context: "run-week/refresh-draft",
        leagueAddress,
        weekId,
        dbStatus: "DRAFT_OPEN",
        expectedOnchainStatus: 1,
      });
    }

    const existingWeek = await getWeekById(weekId);
    const existingWeekCoins = await getWeekCoins(weekId);
    const hasPreparedDraftState =
      existingWeek !== null &&
      String(existingWeek.status ?? "").toUpperCase() === "DRAFT_OPEN" &&
      existingWeekCoins.length > 0;

    if (hasPreparedDraftState) {
      await updateWeekStatus(weekId, "DRAFT_OPEN");
      console.log("[run-week] status moved to DRAFT_OPEN");
      console.log(`run-week skipped: lifecycle intent already completed for week ${weekId}`);
      return;
    }

    console.warn(
      `[run-week] completed lifecycle intent found without full draft DB state for week ${weekId}; rebuilding`,
    );
  }
  console.log("[run-week] setWeekCoins start");
  await setWeekCoins(weekId, weekCoins);
  console.log("[run-week] setWeekCoins done");
  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
  let reactiveTxHash: string | null = isReactiveEvm ? txHash : null;

  try {
    if (txHash && chainEnabled && leagueAddress && !isReactiveEvm) {
      const onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(weekId));
      const onchainStatus = Number(onchainWeek.status ?? 0);
      if (onchainStatus !== 1) {
        throw new Error(
          `DETERMINISTIC: stale create intent for week ${weekId}; tx=${txHash} but on-chain status=${onchainStatus}`,
        );
      }
    }

    if (isReactiveEvm && txHash && chainEnabled && leagueAddress) {
      const onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(weekId));
      const onchainStatus = Number(onchainWeek.status ?? 0);
      if (onchainStatus !== 1) {
        const intentState = String((intent as { status?: unknown }).status ?? "").toLowerCase();
        if ((intentState === "failed" || intentState === "error") && onchainStatus === 0) {
          txHash = null;
          reactiveTxHash = null;
        }
        const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
        const reactiveStallGraceMs = Math.max(
          15_000,
          Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000,
        );
        if (pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs && onchainStatus === 0) {
          txHash = null;
          reactiveTxHash = null;
        }
        if (!txHash) {
          // stale failed tx hash cleared; allow fresh reactive dispatch below
        } else {
          console.log(
            `[run-week] reactive callback pending for week ${weekId}; tx=${txHash}; current on-chain status=${onchainStatus}`,
          );
          return;
        }
      }
    }

    if (!txHash && chainEnabled && leagueAddress) {
      console.log("[run-week] onchain create/check start");
      const onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(weekId));
      const onchainStatus = Number(onchainWeek.status ?? 0);
      const expectedStartAt = Math.floor(startAt.getTime() / 1000);
      const expectedLockAt = Math.floor(lockAt.getTime() / 1000);
      const expectedEndAt = Math.floor(endAt.getTime() / 1000);
      const onchainStartAt = Number(onchainWeek.startAt ?? 0n);
      const onchainLockAt = Number(onchainWeek.lockAt ?? 0n);
      const onchainEndAt = Number(onchainWeek.endAt ?? 0n);
      if (onchainStatus === 0) {
        try {
          const createdTxHash = await createWeekOnchain(
            leagueAddress,
            BigInt(weekId),
            expectedStartAt,
            expectedLockAt,
            expectedEndAt,
            opKey,
          );
          txHash = createdTxHash;
          if (isReactiveEvm) reactiveTxHash = createdTxHash;
          intent =
            (await markLifecycleIntentSubmitted(intent, createdTxHash, {
              txHash: createdTxHash,
              chainExecuted: true,
              reactiveTxHash,
              submittedAtMs: Date.now(),
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
                submittedAtMs: Date.now(),
                pendingConfirmation: true,
              })) ?? intent;
            console.log(
              `[run-week] reactive create submitted tx=${dispatchedReactiveTx}; waiting callback confirmation`,
            );
            return;
          }
          throw error;
        }
      } else if (
        onchainStatus === 1 &&
        onchainStartAt === expectedStartAt &&
        onchainLockAt === expectedLockAt &&
        onchainEndAt === expectedEndAt
      ) {
        // Idempotent replay: on-chain week already created with the same schedule.
      } else {
        throw new Error(
          `Week ${weekId} already exists on-chain with status=${onchainStatus} (start=${onchainStartAt}, lock=${onchainLockAt}, end=${onchainEndAt})`,
        );
      }
    }

    if (chainEnabled && leagueAddress) {
      if (isReactiveEvm && txHash) {
        const onchainWeek = await getOnchainWeekState(leagueAddress, BigInt(weekId));
        const onchainStatus = Number(onchainWeek.status ?? 0);
        if (onchainStatus !== 1) {
          console.log(
            `[run-week] reactive callback pending for week ${weekId}; current on-chain status=${onchainStatus}`,
          );
          return;
        }
      }
      console.log("[run-week] onchain draft assertion start");
      await assertOnchainDraftWeek({
        leagueAddress,
        weekId,
        startAt,
        lockAt,
        endAt,
        context: "run-week/post-create",
      });
    }

    await updateWeekStatus(weekId, "DRAFT_OPEN");
    console.log("[run-week] status moved to DRAFT_OPEN");

    await markLifecycleIntentCompleted(intent, {
      txHash,
      status: "DRAFT_OPEN",
      chainExecuted: Boolean(txHash),
      reactiveTxHash,
      startAt: startAt.toISOString(),
      lockAt: lockAt.toISOString(),
      endAt: endAt.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const extractedReactiveTxHash =
      typeof error === "object" && error !== null
        ? String((error as { reactiveTxHash?: unknown }).reactiveTxHash ?? "").trim().toLowerCase()
        : "";
    if (isReactiveEvm && !reactiveTxHash) {
      if (/^0x[0-9a-f]{64}$/u.test(extractedReactiveTxHash)) {
        reactiveTxHash = extractedReactiveTxHash;
      }
    }
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      status: "PREPARING",
      chainExecuted: Boolean(txHash),
      reactiveTxHash,
      startAt: startAt.toISOString(),
      lockAt: lockAt.toISOString(),
      endAt: endAt.toISOString(),
    });
    throw error;
  }

};





