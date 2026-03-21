/**
 * RedStone Pull Oracle Service
 *
 * Uses RedStone price HTTP API for all price queries (no on-chain feeds)
 * Prices are symbol-based and deterministic through timestamp-based snapshots
 */

import { env } from "../env.js";

const REDSTONE_PRICES_URL = env.REDSTONE_PRICES_URL;
const REDSTONE_PROVIDER = env.REDSTONE_PROVIDER;
const REDSTONE_REQUEST_TIMEOUT_MS = Number(env.REDSTONE_REQUEST_TIMEOUT_MS);
const REDSTONE_MAX_RETRIES = 4;
const REDSTONE_RETRY_BASE_MS = 1200;
const REDSTONE_BATCH_SIZE = 25;
const REDSTONE_BATCH_CONCURRENCY = 4;

// Simple in-memory cache for live prices
const livePriceCache = new Map<
  string,
  { price: number; timestamp: number }
>();
const missingPriceCache = new Map<string, number>();
const LIVE_CACHE_TTL_MS = 30_000; // 30 seconds (UI refresh rate)
const LIVE_STALE_MAX_AGE_MS = 10 * 60_000;
const LIVE_MISSING_RETRY_INTERVAL_MS = 30_000;
let liveRefreshInFlight: Promise<Record<string, number>> | null = null;

/**
 * Get prices for multiple symbols using RedStone Pull API
 * This is the core pricing function used for all scenarios:
 * - UI live prices
 * - Week start/end snapshots
 * - Swap price snapshots
 *
 * @param symbols Array of asset symbols (e.g., ["BTC", "ETH"])
 * @returns Record of symbol -> price (e.g., { BTC: 64231.12, ETH: 3124.88 })
 */
export const getPricesBySymbols = async (
  symbols: string[],
): Promise<Record<string, number>> => {
  const requestedSymbols = Array.from(
    new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0),
    ),
  );
  if (requestedSymbols.length === 0) {
    return {};
  }

  const shouldRetryStatus = (status: number) =>
    status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

  const sleep = async (ms: number) =>
    await new Promise((resolve) => setTimeout(resolve, ms));

  const fetchBatch = async (batchSymbols: string[]) => {
    const params = new URLSearchParams({
      provider: REDSTONE_PROVIDER,
      symbols: batchSymbols.join(","),
    });

    for (let attempt = 1; attempt <= REDSTONE_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        REDSTONE_REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await fetch(`${REDSTONE_PRICES_URL}?${params.toString()}`, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) {
          if (attempt < REDSTONE_MAX_RETRIES && shouldRetryStatus(response.status)) {
            const delay = REDSTONE_RETRY_BASE_MS * attempt;
            await sleep(delay);
            continue;
          }
          throw new Error(`RedStone API error: ${response.status}`);
        }

        const payload = (await response.json()) as Record<
          string,
          { value?: number | string }
        >;
        const result: Record<string, number> = {};

        for (const symbol of batchSymbols) {
          const value = payload?.[symbol]?.value;
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric > 0) {
            result[symbol] = numeric;
          }
        }

        return result;
      } catch (error) {
        if (attempt >= REDSTONE_MAX_RETRIES) {
          throw error;
        }
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        const retryable =
          message.includes("fetch failed") ||
          message.includes("network") ||
          message.includes("timeout") ||
          message.includes("aborted");
        if (!retryable) {
          throw error;
        }
        const delay = REDSTONE_RETRY_BASE_MS * attempt;
        await sleep(delay);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return {};
  };

  const aggregated = new Map<string, number>();
  const chunks: string[][] = [];
  for (let idx = 0; idx < requestedSymbols.length; idx += REDSTONE_BATCH_SIZE) {
    chunks.push(requestedSymbols.slice(idx, idx + REDSTONE_BATCH_SIZE));
  }

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(chunks.length, REDSTONE_BATCH_CONCURRENCY) },
    async () => {
      while (cursor < chunks.length) {
        const index = cursor;
        cursor += 1;
        const chunk = chunks[index];
        try {
          const chunkResult = await fetchBatch(chunk);
          for (const [symbol, price] of Object.entries(chunkResult)) {
            aggregated.set(symbol, price);
          }
        } catch {
          // Ignore failed chunk and keep successful RedStone prices from other chunks.
        }
      }
    },
  );
  await Promise.all(workers);

  if (aggregated.size === 0) {
    throw new Error(`RedStone returned no prices for ${requestedSymbols.length} symbols`);
  }

  const resolved: Record<string, number> = {};
  for (const symbol of requestedSymbols) {
    const price = aggregated.get(symbol);
    if (Number.isFinite(price) && Number(price) > 0) {
      resolved[symbol] = Number(price);
    }
  }

  return resolved;
};

/**
 * Get live prices with caching (for UI updates)
 * Uses 30-second cache to reduce API calls
 *
 * @param symbols Array of asset symbols
 * @returns Record of symbol -> price
 */
export const getLivePrices = async (
  symbols: string[],
): Promise<Record<string, number>> => {
  const now = Date.now();
  const cached: Record<string, number> = {};
  const stale: Record<string, number> = {};
  const staleSymbols: string[] = [];
  const asyncRetrySymbols: string[] = [];
  const blockingSymbols: string[] = [];

  // Check cache
  for (const symbol of symbols) {
    const key = symbol.toUpperCase();
    const cachedEntry = livePriceCache.get(key);
    const missingAt = missingPriceCache.get(key);

    if (cachedEntry && now - cachedEntry.timestamp < LIVE_CACHE_TTL_MS) {
      cached[key] = cachedEntry.price;
    } else if (cachedEntry && now - cachedEntry.timestamp < LIVE_STALE_MAX_AGE_MS) {
      stale[key] = cachedEntry.price;
      staleSymbols.push(key);
    } else if (missingAt && now - missingAt < LIVE_MISSING_RETRY_INTERVAL_MS) {
      // Known-missing symbol within TTL: skip upstream lookup for now.
      continue;
    } else if (missingAt && now - missingAt >= LIVE_MISSING_RETRY_INTERVAL_MS) {
      // Retry known-missing symbols in background so live requests don't stall.
      asyncRetrySymbols.push(key);
    } else {
      blockingSymbols.push(key);
    }
  }

  if (blockingSymbols.length === 0 && staleSymbols.length === 0) {
    return cached;
  }

  const refreshLiveCache = async (targetSymbols: string[]) => {
    let freshPrices: Record<string, number>;
    if (liveRefreshInFlight) {
      freshPrices = await liveRefreshInFlight;
    } else {
      liveRefreshInFlight = getPricesBySymbols(targetSymbols).finally(() => {
        liveRefreshInFlight = null;
      });
      freshPrices = await liveRefreshInFlight;
    }

    const refreshedAt = Date.now();
    for (const [symbol, price] of Object.entries(freshPrices)) {
      livePriceCache.set(symbol, { price, timestamp: refreshedAt });
      missingPriceCache.delete(symbol);
    }

    for (const symbol of targetSymbols) {
      if (!(symbol in freshPrices)) {
        missingPriceCache.set(symbol, refreshedAt);
      }
    }

    return freshPrices;
  };

  if (blockingSymbols.length === 0) {
    const backgroundSymbols = Array.from(new Set([...staleSymbols, ...asyncRetrySymbols]));
    if (backgroundSymbols.length > 0) {
      void refreshLiveCache(backgroundSymbols).catch(() => undefined);
    }
    return { ...cached, ...stale };
  }

  // Fetch fresh prices
  try {
    const freshPrices = await refreshLiveCache(blockingSymbols);
    const backgroundSymbols = Array.from(new Set([...staleSymbols, ...asyncRetrySymbols]));
    if (backgroundSymbols.length > 0) {
      void refreshLiveCache(backgroundSymbols).catch(() => undefined);
    }
    return { ...cached, ...stale, ...freshPrices };
  } catch (error) {
    if (Object.keys(cached).length > 0 || Object.keys(stale).length > 0) {
      return { ...cached, ...stale };
    }
    throw error;
  }
};

/**
 * Clear live price cache (useful for testing)
 */
export const clearCache = () => {
  livePriceCache.clear();
  missingPriceCache.clear();
  liveRefreshInFlight = null;
};
