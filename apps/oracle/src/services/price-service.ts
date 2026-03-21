import { fetchJsonWithRetry } from "./api-client.js";

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

type BinanceExchangeInfo = {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
  }>;
};

let cachedBinanceBaseAssets: Set<string> | null = null;
let cachedBinanceQuoteMap: Map<string, string> | null = null;
const QUOTE_PREFERENCE = ["USDT", "USD", "USDC"];

const buildBinanceQuoteMap = (data: BinanceExchangeInfo) => {
  const map = new Map<string, string>();
  for (const row of data.symbols) {
    if (row.status !== "TRADING") continue;
    const base = row.baseAsset.toUpperCase();
    const quote = row.quoteAsset.toUpperCase();
    if (!QUOTE_PREFERENCE.includes(quote)) continue;
    const current = map.get(base);
    if (!current) {
      map.set(base, quote);
      continue;
    }
    if (QUOTE_PREFERENCE.indexOf(quote) < QUOTE_PREFERENCE.indexOf(current)) {
      map.set(base, quote);
    }
  }
  return map;
};

const fetchBinanceQuoteMap = async (): Promise<Map<string, string>> => {
  if (cachedBinanceQuoteMap) return cachedBinanceQuoteMap;
  const url = "https://api.binance.com/api/v3/exchangeInfo";
  const data = await fetchJsonWithRetry<BinanceExchangeInfo>(url, {}, { maxRetries: 2, timeoutMs: 10000 });
  cachedBinanceQuoteMap = buildBinanceQuoteMap(data);
  return cachedBinanceQuoteMap;
};

export const fetchBinanceBaseAssets = async (): Promise<Set<string>> => {
  if (cachedBinanceBaseAssets) return cachedBinanceBaseAssets;
  const quoteMap = await fetchBinanceQuoteMap();
  cachedBinanceBaseAssets = new Set(quoteMap.keys());
  return cachedBinanceBaseAssets;
};

export const fetchBinanceKlines = async (
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
  limit = 1000,
): Promise<BinanceKline[]> => {
  const quoteMap = await fetchBinanceQuoteMap();
  const base = symbol.toUpperCase();
  const quote = quoteMap.get(base) ?? "USDT";
  const binanceSymbol = `${base}${quote}`;
  const params = new URLSearchParams({
    symbol: binanceSymbol,
    interval,
    startTime: String(startMs),
    endTime: String(endMs),
    limit: String(limit),
  });
  const url = `https://api.binance.com/api/v3/klines?${params.toString()}`;
  return fetchJsonWithRetry<BinanceKline[]>(
    url,
    {},
    { maxRetries: 2, timeoutMs: 10000 },
  );
};
