// Deprecated: Use database categories instead
// export const STABLE_SYMBOLS = ["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "PYUSD"];

/**
 * Coin Filtering Rules
 * Used during migration and runtime filtering to categorize coins
 */
export const COIN_EXCLUDE_KEYWORDS = {
  // Substring matches (case-insensitive)
  substrings: [
    'stable',      // Stablecoins
    'bridge',      // Bridged tokens
    'staking',     // Staking derivatives
    'wrapped',     // Wrapped tokens
    'usd',         // USD variants
    'gold',        // Tokenized gold
    'circle',      // Circle products
    'dollar',      // Dollar variants
    'btc',         // BTC variants
    'eur',         // EUR variants
    'staked',      // Staked tokens
    'heloc',       // Figure Heloc (broken stable structure)
  ],
  // Whole word matches (case-insensitive)
  wholeWords: [
    'eth',         // Ethereum (catches "Ethereum" but not "Ethena")
    'weth',        // Wrapped ETH
    'gteth',       // GigaToken ETH
    'binance',     // Binance-pegged tokens
  ],
};

export const BUDGET_WEEKLY = 100000;
export const POSITION_RULES = {
  GK: { stable: true, count: 10, startRank: 1, endRank: 10 },
  DEF: { stable: false, count: 25, startRank: 1, endRank: 25 },
  MID: { stable: false, count: 75, startRank: 26, endRank: 100 },
  FWD: { stable: false, count: 200, startRank: 101, endRank: 300 },
};
