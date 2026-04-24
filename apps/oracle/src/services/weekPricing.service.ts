/**
 * Weekly Price Snapshot Service
 *
 * Handles:
 * - Week start price snapshots (global, per coin)
 * - Week end price snapshots (global, per coin)
 * - Swap position price tracking (user-specific)
 * - Finalization of active positions at week end
 *
 * Uses RedStone Pull API for all price queries
 */

import {
  DbWeeklyCoinPrice,
  DbLineupPosition,
  queryRead,
  withWriteTransaction,
} from "../db/db.js";
import { getPricesBySymbols } from "./priceOracle.service.js";
import { getWeekCoins, getCoins } from "../store.js";
import { getRuntimeProvider } from "../network/chain-runtime.js";
type SnapshotOptions = {
  txHash?: string | null;
  timestamp?: number | null;
};

const resolveSnapshotTimestamp = async (options: SnapshotOptions): Promise<number> => {
  if (options.timestamp && Number.isFinite(options.timestamp)) {
    return Math.floor(options.timestamp);
  }
  if (options.txHash) {
    return await getTxTimestamp(options.txHash);
  }
  throw new Error("Missing tx hash or timestamp for snapshot.");
};


/**
 * Get transaction receipt and timestamp from tx hash
 */
const getTxTimestamp = async (txHash: string): Promise<number> => {
  const provider = await getRuntimeProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`Transaction receipt not found for ${txHash}`);
  }
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) {
    throw new Error(`Block not found for tx ${txHash}`);
  }
  return block.timestamp;
};

/**
 * Snapshot week start prices for all eligible coins
 * Idempotent: will not overwrite existing start prices
 */
export const snapshotWeekStartPrices = async (
  weekId: string,
  options: SnapshotOptions,
): Promise<void> => {
  const timestamp = await resolveSnapshotTimestamp(options);

  const weekCoins = await getWeekCoins(weekId);
  const allCoins = await getCoins();
  const coinMap = new Map(allCoins.map((coin) => [coin.id, coin]));
  const symbols = weekCoins
    .map((wc) => coinMap.get(wc.coin_id)?.symbol ?? "")
    .filter(Boolean);

  const prices = await getPricesBySymbols(symbols);

  await withWriteTransaction(async (client) => {
    const stmt = `
      INSERT INTO weekly_coin_prices (
        week_id, symbol, start_price, start_timestamp, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, now()::text, now()::text)
      ON CONFLICT(week_id, symbol) DO UPDATE SET
        start_price = COALESCE(weekly_coin_prices.start_price, EXCLUDED.start_price),
        start_timestamp = COALESCE(weekly_coin_prices.start_timestamp, EXCLUDED.start_timestamp),
        updated_at = now()::text
    `;

    for (const symbol of symbols) {
      const price = prices[symbol.toUpperCase()];
      if (price === undefined) continue;
      await client.query(stmt, [weekId, symbol.toUpperCase(), price, timestamp]);
    }
  });
};


/**
 * Snapshot week end prices for all eligible coins
 * Idempotent: will not overwrite existing end prices
 */
export const snapshotWeekEndPrices = async (
  weekId: string,
  options: SnapshotOptions,
): Promise<void> => {
  const timestamp = await resolveSnapshotTimestamp(options);

  const weekCoins = await getWeekCoins(weekId);
  const allCoins = await getCoins();
  const coinMap = new Map(allCoins.map((coin) => [coin.id, coin]));
  const symbols = weekCoins
    .map((wc) => coinMap.get(wc.coin_id)?.symbol ?? "")
    .filter(Boolean);

  const prices = await getPricesBySymbols(symbols);

  await withWriteTransaction(async (client) => {
    const stmt = `
      INSERT INTO weekly_coin_prices (
        week_id, symbol, end_price, end_timestamp, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, now()::text, now()::text)
      ON CONFLICT(week_id, symbol) DO UPDATE SET
        end_price = COALESCE(weekly_coin_prices.end_price, EXCLUDED.end_price),
        end_timestamp = COALESCE(weekly_coin_prices.end_timestamp, EXCLUDED.end_timestamp),
        updated_at = now()::text
    `;

    for (const symbol of symbols) {
      const price = prices[symbol.toUpperCase()];
      if (price === undefined) continue;
      await client.query(stmt, [weekId, symbol.toUpperCase(), price, timestamp]);
    }
  });
};

/**
 * Parameters for applying a swap price segment
 */
export type ApplySwapParams = {
  weekId: string;
  lineupId: string;
  slotId: string;
  removedSymbol: string;
  addedSymbol: string;
  swapTxHash: string;
};

/**
 * Apply swap price segment (close old position, open new position)
 * Idempotent: detects if swap already processed
 */
export const applySwapPriceSegment = async (
  params: ApplySwapParams,
): Promise<void> => {
  const removedSymbol = params.removedSymbol.toUpperCase();
  const addedSymbol = params.addedSymbol.toUpperCase();
  const timestamp = await getTxTimestamp(params.swapTxHash);

  const prices = await getPricesBySymbols([removedSymbol, addedSymbol]);
  const removedPrice = prices[removedSymbol];
  const addedPrice = prices[addedSymbol];

  if (removedPrice === undefined || addedPrice === undefined) {
    throw new Error(
      `Failed to fetch prices for swap: ${removedSymbol} or ${addedSymbol}`,
    );
  }

  await withWriteTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [params.lineupId, params.slotId],
    );

    const swapInsert = await client.query<{ id: number }>(
      `
        INSERT INTO swap_log (
          week_id, lineup_id, swap_tx_hash, removed_symbol, added_symbol, swap_timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (swap_tx_hash) DO NOTHING
        RETURNING id
      `,
      [
        params.weekId,
        params.lineupId,
        params.swapTxHash,
        removedSymbol,
        addedSymbol,
        timestamp,
      ],
    );

    if (!swapInsert.rows[0]) {
      return;
    }

    let activeRows = await client.query<DbLineupPosition>(
      `
        SELECT * FROM lineup_positions
        WHERE lineup_id = $1 AND slot_id = $2 AND is_active = 1
      `,
      [params.lineupId, params.slotId],
    );

    // Recovery path: if active slot is missing (old data / partial migration),
    // seed it from week baseline so this swap can still be persisted.
    if (!activeRows.rows[0]) {
      const seed = await client.query<{
        salary_used: number;
        start_price: number | null;
        start_timestamp: number | null;
      }>(
        `
          SELECT
            wc.salary AS salary_used,
            wcp.start_price,
            wcp.start_timestamp
          FROM week_coins wc
          INNER JOIN coins c ON c.id = wc.coin_id
          LEFT JOIN weekly_coin_prices wcp
            ON wcp.week_id = wc.week_id
           AND wcp.symbol = UPPER(c.symbol)
          WHERE wc.week_id = $1
            AND UPPER(c.symbol) = $2
          LIMIT 1
        `,
        [params.weekId, removedSymbol],
      );

      const seedRow = seed.rows[0];
      if (!seedRow || seedRow.start_price === null) {
        throw new Error(
          `Cannot seed active position for ${params.lineupId}/${params.slotId} (missing week baseline for ${removedSymbol})`,
        );
      }

      await client.query(
        `
          INSERT INTO lineup_positions (
            week_id, lineup_id, slot_id, symbol, salary_used,
            start_price, start_timestamp, is_active, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now()::text, now()::text)
        `,
        [
          params.weekId,
          params.lineupId,
          params.slotId,
          removedSymbol,
          Number(seedRow.salary_used),
          Number(seedRow.start_price),
          Number(seedRow.start_timestamp ?? timestamp),
        ],
      );

      activeRows = await client.query<DbLineupPosition>(
        `
          SELECT * FROM lineup_positions
          WHERE lineup_id = $1 AND slot_id = $2 AND is_active = 1
        `,
        [params.lineupId, params.slotId],
      );
    }

    const activePosition = activeRows.rows[0];
    if (!activePosition) {
      throw new Error(
        `No active position found for lineup ${params.lineupId} slot ${params.slotId}`,
      );
    }

    const activeSymbol = activePosition.symbol.toUpperCase();
    if (activeSymbol !== removedSymbol) {
      if (activeSymbol === addedSymbol) {
        return;
      }

      throw new Error(
        `Position symbol mismatch: expected ${removedSymbol}, got ${activePosition.symbol}`,
      );
    }

    await client.query(
      `
        UPDATE lineup_positions
        SET end_price = $1, end_timestamp = $2, is_active = 0, updated_at = now()::text
        WHERE id = $3
      `,
      [removedPrice, timestamp, activePosition.id],
    );

    await client.query(
      `
        INSERT INTO lineup_positions (
          week_id, lineup_id, slot_id, symbol, salary_used,
          start_price, start_timestamp, is_active, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now()::text, now()::text)
      `,
      [
        params.weekId,
        params.lineupId,
        params.slotId,
        addedSymbol,
        activePosition.salary_used,
        addedPrice,
        timestamp,
      ],
    );
  });
};

/**
 * Finalize all active positions at week end
 */
export const finalizeActivePositionsAtWeekEnd = async (
  weekId: string,
): Promise<void> => {
  const activePositions = await queryRead<DbLineupPosition>(
    "SELECT * FROM lineup_positions WHERE week_id = $1 AND is_active = 1",
    [weekId],
  );

  if (!activePositions.length) {
    return;
  }

  await withWriteTransaction(async (client) => {
    const stmt = `
      UPDATE lineup_positions
      SET
        end_price = (
          SELECT end_price FROM weekly_coin_prices
          WHERE week_id = $1 AND symbol = $2
        ),
        end_timestamp = (
          SELECT end_timestamp FROM weekly_coin_prices
          WHERE week_id = $1 AND symbol = $2
        ),
        is_active = 0,
        updated_at = now()::text
      WHERE id = $3
    `;

    for (const position of activePositions) {
      await client.query(stmt, [weekId, position.symbol, position.id]);
    }
  });
};

/**
 * Get weekly coin prices for a week
 */
export const getWeeklyCoinPrices = async (weekId: string): Promise<DbWeeklyCoinPrice[]> => {
  return queryRead<DbWeeklyCoinPrice>(
    "SELECT * FROM weekly_coin_prices WHERE week_id = $1",
    [weekId],
  );
};

/**
 * Get lineup positions for a specific lineup
 */
export const getLineupPositions = async (
  lineupId: string,
): Promise<DbLineupPosition[]> => {
  return queryRead<DbLineupPosition>(
    "SELECT * FROM lineup_positions WHERE lineup_id = $1 ORDER BY created_at ASC",
    [lineupId],
  );
};
