/**
 * Coin Logo Download Service
 * Downloads coin logos from CoinCap and saves to public directory
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Public directory path (apps/web/public/coins/)
const PUBLIC_COINS_DIR = resolve(__dirname, "../../../web/public/coins");
const LOGO_FETCH_TIMEOUT_MS = 8000;

/**
 * Ensure public/coins directory exists
 */
export const ensureCoinsDirectory = () => {
  if (!existsSync(PUBLIC_COINS_DIR)) {
    mkdirSync(PUBLIC_COINS_DIR, { recursive: true });
    // Directory created
  }
};

/**
 * Download coin logo from CoinCap and save to public directory
 * Returns relative path (e.g., "/coins/btc.png") or null if failed
 */
export const downloadCoinLogo = async (
  symbol: string,
  coinId: string,
): Promise<string | null> => {
  try {
    const symbolLower = symbol.toLowerCase();
    const fileName = `${symbolLower}.png`;
    const filePath = resolve(PUBLIC_COINS_DIR, fileName);

    // Skip if already downloaded
    if (existsSync(filePath)) {
      return `/coins/${fileName}`;
    }

    // Download from CoinCap (transparent background)
    const url = `https://assets.coincap.io/assets/icons/${symbolLower}@2x.png`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    writeFileSync(filePath, Buffer.from(buffer));

    return `/coins/${fileName}`;
  } catch {
    return null;
  }
};
