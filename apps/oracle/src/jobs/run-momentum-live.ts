import { getWeeks, getWeekCoins, getCoins, updateWeekCoinMomentumLive } from "../store.js";
import { fetchBinanceKlines } from "../services/price-service.js";
import { sleep } from "../services/api-client.js";

const HOURS_PER_DAY = 24;
const LOOKBACK_DAYS = 21;
const RATE_MS = 200;

const mean = (values: number[]) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
};

const priceAtHoursAgo = (series: number[], hoursAgo: number) => {
  if (!series.length) return null;
  const idx = series.length - 1 - hoursAgo;
  if (idx < 0) return series[0] ?? null;
  return series[idx] ?? null;
};

const computeRawMomentum = (prices: number[], volumes: number[]) => {
  if (!prices.length) return null;
  const lastPrice = prices[prices.length - 1];
  const price7d = priceAtHoursAgo(prices, HOURS_PER_DAY * 7);
  const price14d = priceAtHoursAgo(prices, HOURS_PER_DAY * 14);
  const return7 = price7d && price7d > 0 ? lastPrice / price7d - 1 : 0;
  const return14 = price14d && price14d > 0 ? lastPrice / price14d - 1 : 0;
  const shortTermReturn = (return7 + return14) / 2;

  const ma7 = mean(prices.slice(-HOURS_PER_DAY * 7));
  const ma21 = mean(prices.slice(-HOURS_PER_DAY * 21));
  const maSlope = ma7 - ma21;

  const last7Vol = mean(volumes.slice(-HOURS_PER_DAY * 7));
  const prev7Vol = mean(volumes.slice(-HOURS_PER_DAY * 14, -HOURS_PER_DAY * 7));
  const volumeTrend = prev7Vol > 0 ? last7Vol / prev7Vol - 1 : 0;

  return shortTermReturn + maSlope + volumeTrend;
};

const run = async () => {
  const weeks = await getWeeks();
  const currentWeek = weeks[0];
  if (!currentWeek) return;

  const weekCoins = await getWeekCoins(currentWeek.id);
  const coins = await getCoins();
  const coinMap = new Map(coins.map((coin) => [coin.id, coin]));

  const rawByCoin = new Map<string, number>();

  for (const row of weekCoins) {
    const coin = coinMap.get(row.coin_id);
    if (!coin) continue;
    try {
      const endMs = Date.now();
      const startMs = endMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      const klines = await fetchBinanceKlines(coin.symbol, "1h", startMs, endMs, 1000);
      const closes = klines.map((k) => Number(k[4])).filter(Number.isFinite);
      const volumes = klines.map((k) => Number(k[5])).filter(Number.isFinite);
      const raw = computeRawMomentum(closes, volumes);
      if (raw !== null) {
        rawByCoin.set(row.coin_id, raw);
      }
    } catch {
      // Skip coins without Binance data
    }
    await sleep(RATE_MS);
  }

  const rawValues = Array.from(rawByCoin.values());
  const low = percentile(rawValues, 33);
  const high = percentile(rawValues, 66);
  const now = new Date().toISOString();

  for (const row of weekCoins) {
    const raw = rawByCoin.get(row.coin_id);
    if (raw === undefined) continue;
    const momentum = raw < low ? "Down" : raw < high ? "Steady" : "Up";
    await updateWeekCoinMomentumLive(currentWeek.id, row.coin_id, momentum, now);
  }
};

run().catch(() => {
  process.exit(1);
});
