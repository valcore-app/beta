import { env } from "../env.js";
import { ApiError, fetchJsonWithRetry, sleep, withConcurrency } from "./api-client.js";
import { fetchBinanceKlines, getBinanceIntervalMs } from "./price-service.js";

type MarketChart = {
  prices: [number, number][];
  total_volumes: [number, number][];
};

type RawMetrics = {
  rawPower: number;
  rawRisk: number;
  rawMomentum: number;
};

export type SnapshotMetric = {
  power: number;
  risk: "Low" | "Medium" | "High";
  momentum: "Down" | "Steady" | "Up";
  raw: RawMetrics;
};

type ComputeSnapshotOptions = {
  preferBinance?: boolean;
};

type CoinTarget = {
  id: string;
  symbol: string;
};

const MARKET_CHART_ENDPOINT = "/coins";
const COINGECKO_RATE_MS = 2500;
const BINANCE_RATE_MS = 200;
const BINANCE_METRICS_CONCURRENCY = Math.max(1, Number(env.SNAPSHOT_METRICS_BINANCE_CONCURRENCY ?? "6") || 6);
const BINANCE_METRICS_DELAY_MS = Math.max(0, Number(env.SNAPSHOT_METRICS_BINANCE_DELAY_MS ?? "50") || 50);
const METRICS_COIN_TIMEOUT_MS = 45000;
const POWER_RET7_WEIGHT = 1.0;
const POWER_RET30_WEIGHT = 2.5;
const POWER_MA_WEIGHT = 1.5;
const POWER_UPVOL_WEIGHT = 1.0;
const POWER_DRAWDOWN_WEIGHT = 2.0;

const mean = (values: number[]) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stddev = (values: number[]) => {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
};

const logReturns = (prices: number[]) => {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const current = prices[i];
    if (!Number.isFinite(prev) || !Number.isFinite(current) || prev <= 0) continue;
    returns.push(Math.log(current / prev));
  }
  return returns;
};

const mergeChartRows = (chart: MarketChart) => {
  const length = Math.min(chart.prices.length, chart.total_volumes.length);
  const rows: [number, number, number][] = [];
  for (let i = 0; i < length; i += 1) {
    rows.push([chart.prices[i][0], chart.prices[i][1], chart.total_volumes[i][1]]);
  }
  return rows;
};

const computeMaxDrawdown = (prices: number[]) => {
  let peak = 0;
  let maxDrop = 0;
  for (const price of prices) {
    if (!Number.isFinite(price)) continue;
    if (price > peak) peak = price;
    if (peak <= 0) continue;
    const drawdown = (price - peak) / peak;
    if (drawdown < maxDrop) {
      maxDrop = drawdown;
    }
  }
  return Math.abs(maxDrop);
};

const sliceByTime = (rows: [number, number, number][], startMs: number, endMs: number) =>
  rows.filter(([ts]) => ts >= startMs && ts < endMs);

const priceAtHoursAgo = (series: [number, number][], hoursAgo: number) => {
  if (!series.length) return null;
  const target = series[series.length - 1][0] - hoursAgo * 60 * 60 * 1000;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i][0] <= target) return series[i][1];
  }
  return series[0][1] ?? null;
};

const averageLast = (values: number[], count: number) => {
  if (!values.length) return 0;
  const slice = values.slice(Math.max(0, values.length - count));
  return mean(slice);
};

const groupDaily = (prices: [number, number][], volumes: [number, number][]) => {
  const dailyPrices = new Map<string, number[]>();
  const dailyVolumes = new Map<string, number[]>();

  for (const [ts, price] of prices) {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!dailyPrices.has(day)) dailyPrices.set(day, []);
    dailyPrices.get(day)!.push(price);
  }

  for (const [ts, volume] of volumes) {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!dailyVolumes.has(day)) dailyVolumes.set(day, []);
    dailyVolumes.get(day)!.push(volume);
  }

  const days = Array.from(new Set([...dailyPrices.keys(), ...dailyVolumes.keys()])).sort();
  const ranges: number[] = [];
  const volumesSum: number[] = [];

  for (const day of days) {
    const dayPrices = dailyPrices.get(day) ?? [];
    if (dayPrices.length) {
      const high = Math.max(...dayPrices);
      const low = Math.min(...dayPrices);
      const close = dayPrices[dayPrices.length - 1];
      if (Number.isFinite(close) && close > 0) {
        ranges.push((high - low) / close);
      }
    }
    const dayVolumes = dailyVolumes.get(day) ?? [];
    if (dayVolumes.length) {
      const totalVol = dayVolumes.reduce((sum, value) => sum + value, 0);
      volumesSum.push(totalVol);
    }
  }

  return { ranges, volumesSum };
};

const computeBeta = (returns: number[], btcReturns: number[]) => {
  const len = Math.min(returns.length, btcReturns.length);
  if (len <= 1) return 0;
  const a = returns.slice(returns.length - len);
  const b = btcReturns.slice(btcReturns.length - len);
  const meanA = mean(a);
  const meanB = mean(b);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < len; i += 1) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varB += (b[i] - meanB) ** 2;
  }
  if (varB === 0) return 0;
  return cov / varB;
};

const fetchMarketChart = async (
  coinId: string,
  days: number,
  headers?: Record<string, string>,
) => {
  const url = `${env.COINGECKO_BASE_URL}${MARKET_CHART_ENDPOINT}/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  return fetchJsonWithRetry<MarketChart>(url, headers, { maxRetries: 2, timeoutMs: 15000 });
};

const buildMarketChartFromKlines = (klines: Awaited<ReturnType<typeof fetchBinanceKlines>>) => {
  const prices: [number, number][] = [];
  const totalVolumes: [number, number][] = [];
  for (const kline of klines) {
    const openTime = kline[0];
    const close = Number(kline[4]);
    const volume = Number(kline[5]);
    if (Number.isFinite(close)) {
      prices.push([openTime, close]);
    }
    if (Number.isFinite(volume)) {
      totalVolumes.push([openTime, volume]);
    }
  }
  return { prices, total_volumes: totalVolumes } satisfies MarketChart;
};

const fetchBinanceMarketChartRange = async (
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<MarketChart> => {
  const prices: [number, number][] = [];
  const totalVolumes: [number, number][] = [];
  const interval = "1h";
  const intervalMs = getBinanceIntervalMs(interval);
  const pageLimit = 1000;
  let cursor = startMs;
  let guard = 0;

  while (cursor < endMs && guard < 20) {
    const klines = await fetchBinanceKlines(symbol, interval, cursor, endMs, pageLimit);
    if (!klines.length) break;
    const chart = buildMarketChartFromKlines(klines);
    prices.push(...chart.prices);
    totalVolumes.push(...chart.total_volumes);

    const lastTime = klines[klines.length - 1][0];
    if (!Number.isFinite(lastTime) || lastTime < cursor) break;

    // Binance returns up to limit rows; if fewer arrived, range is exhausted.
    if (klines.length < pageLimit) break;

    const nextCursor = lastTime + intervalMs;
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
    cursor = nextCursor;
    guard += 1;
    await sleep(BINANCE_RATE_MS);
  }

  return { prices, total_volumes: totalVolumes };
};
const withTimeoutFallback = async <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const fetchBinanceMarketChart = async (symbol: string, days: number): Promise<MarketChart> => {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  return fetchBinanceMarketChartRange(symbol, startMs, endMs);
};

const shouldFallbackToBinance = (error: unknown) => {
  if (!(error instanceof ApiError)) return false;
  const code = error.statusCode ?? 0;
  return code === 401 || code === 403 || code === 429 || code === 400;
};

const computeRawMetrics = (
  chart: MarketChart,
  btcReturns: number[],
): RawMetrics => {
  const prices = chart.prices.map((row) => row[1]).filter(Number.isFinite);
  const returns = logReturns(prices);
  const downsideReturns = returns.filter((value) => value < 0);
  const { ranges, volumesSum } = groupDaily(chart.prices, chart.total_volumes);

  const vol30d = stddev(returns);
  const avgRange = mean(ranges);
  const avgDailyVol = mean(volumesSum);
  const logVolume = avgDailyVol > 0 ? Math.log(avgDailyVol) : 0;
  const downsideVol = stddev(downsideReturns);
  const maxDrawdown = computeMaxDrawdown(prices);
  const beta = computeBeta(returns, btcReturns);

  const price7d = priceAtHoursAgo(chart.prices, 24 * 7);
  const price14d = priceAtHoursAgo(chart.prices, 24 * 14);
  const lastPrice = prices[prices.length - 1] ?? 0;
  const return7 = price7d && price7d > 0 ? lastPrice / price7d - 1 : 0;
  const return14 = price14d && price14d > 0 ? lastPrice / price14d - 1 : 0;
  const shortTermReturn = (return7 + return14) / 2;

  const ma7 = averageLast(prices, 24 * 7);
  const ma21 = averageLast(prices, 24 * 21);
  const maSlope = ma7 - ma21;

  const last7Vol = mean(volumesSum.slice(-7));
  const prev7Vol = mean(volumesSum.slice(-14, -7));
  const volumeTrend = prev7Vol > 0 ? last7Vol / prev7Vol - 1 : 0;

  const rawPower = vol30d + avgRange + logVolume;
  const rawRisk = downsideVol + beta + maxDrawdown;
  const rawMomentum = shortTermReturn + maSlope + volumeTrend;

  return { rawPower, rawRisk, rawMomentum };
};

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
const logit = (value: number) => Math.log(value / (1 - value));

const computeRawPower = (rows: [number, number, number][]) => {
  const prices = rows.map((row) => row[1]).filter(Number.isFinite);
  const returns = logReturns(prices);
  const { ranges, volumesSum } = groupDaily(
    rows.map(([ts, price]) => [ts, price]),
    rows.map(([ts, , volume]) => [ts, volume]),
  );
  const vol = stddev(returns);
  const avgRange = mean(ranges);
  const avgVol = mean(volumesSum);
  const logVol = avgVol > 0 ? Math.log(avgVol) : 0;
  return vol + avgRange + logVol;
};
const computePowerFR4 = (chart: MarketChart) => {
  const rows = mergeChartRows(chart);
  if (!rows.length) return 50;

  const endMs = rows[rows.length - 1][0];
  const last30Start = endMs - 30 * 24 * 60 * 60 * 1000;
  const last7Start = endMs - 7 * 24 * 60 * 60 * 1000;

  const rows30 = sliceByTime(rows, last30Start, endMs);
  const rows7 = sliceByTime(rows, last7Start, endMs);

  if (!rows30.length || !rows7.length) return 50;

  const rawPower7 = computeRawPower(rows7);

  const series: number[] = [];
  for (let d = 30; d >= 1; d -= 1) {
    const tEnd = endMs - (d - 1) * 24 * 60 * 60 * 1000;
    const tStart = tEnd - 7 * 24 * 60 * 60 * 1000;
    const window = sliceByTime(rows, tStart, tEnd);
    if (window.length >= 24 * 3) {
      series.push(computeRawPower(window));
    }
  }
  const powerMean = mean(series);
  const powerStd = stddev(series) || 1;
  const energy = sigmoid((rawPower7 - powerMean) / powerStd);

  const prices30 = rows30.map((row) => row[1]).filter(Number.isFinite);
  const volumes30 = rows30.map((row) => row[2]).filter(Number.isFinite);

  const priceAtHours = (hoursAgo: number) => {
    const target = endMs - hoursAgo * 60 * 60 * 1000;
    for (let i = rows30.length - 1; i >= 0; i -= 1) {
      if (rows30[i][0] <= target) return rows30[i][1];
    }
    return rows30[0]?.[1] ?? 0;
  };

  const lastPrice = prices30[prices30.length - 1] ?? 0;
  const price7 = priceAtHours(24 * 7);
  const price30 = priceAtHours(24 * 30);
  const return7 = price7 > 0 ? lastPrice / price7 - 1 : 0;
  const return30 = price30 > 0 ? lastPrice / price30 - 1 : 0;

  const ma7 = averageLast(prices30, 24 * 7);
  const ma30 = averageLast(prices30, 24 * 30);
  const maSlope = ma30 > 0 ? (ma7 - ma30) / ma30 : 0;

  let upVol = 0;
  let downVol = 0;
  const len = Math.min(prices30.length, volumes30.length);
  for (let i = 1; i < len; i += 1) {
    const delta = prices30[i] - prices30[i - 1];
    const vol = volumes30[i];
    if (!Number.isFinite(vol)) continue;
    if (delta >= 0) {
      upVol += vol;
    } else {
      downVol += vol;
    }
  }
  const totalVol = upVol + downVol;
  const upVolRatio = totalVol > 0 ? upVol / totalVol : 0.5;

  const drawdown = computeMaxDrawdown(prices30);

  const heatInput =
    POWER_RET7_WEIGHT * return7 +
    POWER_RET30_WEIGHT * return30 +
    POWER_MA_WEIGHT * maSlope +
    POWER_UPVOL_WEIGHT * (upVolRatio - 0.5) -
    POWER_DRAWDOWN_WEIGHT * drawdown;
  const heat = sigmoid(heatInput);

  const safeEnergy = Math.max(1e-4, Math.min(1 - 1e-4, energy));
  const safeHeat = Math.max(1e-4, Math.min(1 - 1e-4, heat));
  const score = logit(safeEnergy) + logit(safeHeat);
  const powerFR3 = 100 * sigmoid(score);
  const powerFR4 = 50 + 0.5 * powerFR3;

  return Math.round(powerFR4);
};

export const computeSnapshotMetrics = async (
  coins: CoinTarget[],
  headers?: Record<string, string>,
  options: ComputeSnapshotOptions = {},
): Promise<Record<string, SnapshotMetric>> => {
  let btcReturns: number[] = [];
  let forceBinance = Boolean(options.preferBinance);
  try {
    const btcChart = forceBinance
      ? await fetchBinanceMarketChart("BTC", 30)
      : await fetchMarketChart("bitcoin", 30, headers);
    btcReturns = logReturns(btcChart.prices.map((row) => row[1]).filter(Number.isFinite));
  } catch (error) {
    if (shouldFallbackToBinance(error)) {
      forceBinance = true;
      try {
        const btcChart = await fetchBinanceMarketChart("BTC", 30);
        btcReturns = logReturns(btcChart.prices.map((row) => row[1]).filter(Number.isFinite));
      } catch {
        // leave btcReturns empty and proceed with defaults
      }
    } else {
      throw error;
    }
  }

  const rawByCoin = new Map<string, RawMetrics>();
  const powerByCoin = new Map<string, number>();

  const resolveCoinMetrics = async (coin: CoinTarget, preferBinance: boolean) => {
    try {
      const shortChart = preferBinance
        ? await fetchBinanceMarketChart(coin.symbol, 30)
        : await fetchMarketChart(coin.id, 30, headers);
      return {
        raw: computeRawMetrics(shortChart, btcReturns),
        power: computePowerFR4(shortChart),
      };
    } catch (error) {
      if (!preferBinance && shouldFallbackToBinance(error)) {
        try {
          const shortChart = await fetchBinanceMarketChart(coin.symbol, 30);
          return {
            raw: computeRawMetrics(shortChart, btcReturns),
            power: computePowerFR4(shortChart),
          };
        } catch {
          // Fall through to defaults.
        }
      }
      return { raw: { rawPower: 0, rawRisk: 0, rawMomentum: 0 }, power: 50 };
    }
  };

  if (forceBinance) {
    const targets = coins.map((coin, index) => ({ coin, index }));
    let completed = 0;
    const resolved = await withConcurrency(targets, BINANCE_METRICS_CONCURRENCY, async ({ coin, index }) => {
      if (BINANCE_METRICS_DELAY_MS > 0) {
        await sleep((index % BINANCE_METRICS_CONCURRENCY) * BINANCE_METRICS_DELAY_MS);
      }
      const metric = await withTimeoutFallback(resolveCoinMetrics(coin, true), METRICS_COIN_TIMEOUT_MS, { raw: { rawPower: 0, rawRisk: 0, rawMomentum: 0 }, power: 50 });
      completed += 1;
      if (completed % 10 === 0 || completed === targets.length) {
        console.log(`[metrics] progress ${completed}/${targets.length}`);
      }
      return { coinId: coin.id, metric };
    });
    for (const row of resolved) {
      rawByCoin.set(row.coinId, row.metric.raw);
      powerByCoin.set(row.coinId, row.metric.power);
    }
  } else {
    for (const coin of coins) {
      const metric = await withTimeoutFallback(resolveCoinMetrics(coin, false), METRICS_COIN_TIMEOUT_MS, { raw: { rawPower: 0, rawRisk: 0, rawMomentum: 0 }, power: 50 });
      rawByCoin.set(coin.id, metric.raw);
      powerByCoin.set(coin.id, metric.power);
      await sleep(COINGECKO_RATE_MS);
    }
  }

  const rawRiskValues = Array.from(rawByCoin.values()).map((r) => r.rawRisk);
  const rawMomValues = Array.from(rawByCoin.values()).map((r) => r.rawMomentum);

  const riskLow = percentile(rawRiskValues, 33);
  const riskHigh = percentile(rawRiskValues, 66);
  const momLow = percentile(rawMomValues, 33);
  const momHigh = percentile(rawMomValues, 66);

  const results: Record<string, SnapshotMetric> = {};

  for (const [coinId, raw] of rawByCoin.entries()) {
    const finalPower = powerByCoin.get(coinId) ?? 50;
    const risk =
      raw.rawRisk < riskLow ? "Low" : raw.rawRisk < riskHigh ? "Medium" : "High";
    const momentum =
      raw.rawMomentum < momLow
        ? "Down"
        : raw.rawMomentum < momHigh
          ? "Steady"
          : "Up";
    results[coinId] = { power: finalPower, risk, momentum, raw };
  }

  return results;
};





