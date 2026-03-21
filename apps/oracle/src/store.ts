// @ts-nocheck
import { queryRead, queryWrite, withWriteTransaction, } from "./db/db.js";
/**
 * Postgres-based store
 */
// ==================== WEEKS ====================
export const upsertWeek = async (week) => {
    await queryWrite(`
    INSERT INTO weeks (id, start_at, lock_at, end_at, status)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(id) DO UPDATE SET
      start_at = EXCLUDED.start_at,
      lock_at = EXCLUDED.lock_at,
      end_at = EXCLUDED.end_at,
      status = EXCLUDED.status
  `, [week.id, week.start_at, week.lock_at, week.end_at, week.status]);
};
export const getWeeks = async () => {
    return queryRead("SELECT * FROM weeks ORDER BY start_at DESC");
};
export const getWeekById = async (weekId) => {
    const rows = await queryRead("SELECT * FROM weeks WHERE id = $1", [weekId]);
    return rows[0];
};
export const updateWeekStatus = async (weekId, status) => {
    const normalized = String(status ?? "").toUpperCase();
    if (normalized === "FINALIZE_PENDING" || normalized === "FINALIZED") {
        await queryWrite("UPDATE weeks SET status = $1, finalized_at = COALESCE(finalized_at, now()::text) WHERE id = $2", [status, weekId]);
        return;
    }
    if (normalized === "ACTIVE") {
        await queryWrite("UPDATE weeks SET status = $1, finalized_at = NULL WHERE id = $2", [status, weekId]);
        return;
    }
    await queryWrite("UPDATE weeks SET status = $1 WHERE id = $2", [status, weekId]);
};
// ==================== COINS ====================
export const upsertCoin = async (coin) => {
    await queryWrite(`
    INSERT INTO coins (id, symbol, name, category_id, image_path, last_updated)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(id) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      name = EXCLUDED.name,
      category_id = EXCLUDED.category_id,
      image_path = COALESCE(EXCLUDED.image_path, coins.image_path),
      last_updated = EXCLUDED.last_updated
  `, [
        coin.id,
        coin.symbol,
        coin.name,
        coin.category_id,
        coin.image_path,
        coin.last_updated,
    ]);
};
export const getCoins = async () => {
    return queryRead("SELECT * FROM coins ORDER BY created_at ASC");
};
export const getCoinById = async (coinId) => {
    const rows = await queryRead("SELECT * FROM coins WHERE id = $1", [coinId]);
    return rows[0];
};
export const getCoinsByCategory = async (categoryId) => {
    return queryRead("SELECT * FROM coins WHERE category_id = $1 ORDER BY created_at ASC", [categoryId]);
};
// ==================== COIN CATEGORIES ====================
export const upsertCoinCategory = async (category) => {
    await queryWrite(`
    INSERT INTO coin_categories (id, name, description, sort_order)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order
  `, [category.id, category.name, category.description, category.sort_order]);
};
export const getCategories = async () => {
    return queryRead("SELECT * FROM coin_categories ORDER BY sort_order ASC");
};
export const getCategoryById = async (categoryId) => {
    const rows = await queryRead("SELECT * FROM coin_categories WHERE id = $1", [categoryId]);
    return rows[0];
};
export const clearAllCoins = async () => {
    await queryWrite("DELETE FROM coins");
};
// ==================== WEEK COINS ====================
export const setWeekCoins = async (weekId, rows) => {
    await withWriteTransaction(async (client) => {
        await client.query("DELETE FROM week_coins WHERE week_id = $1", [weekId]);
        const stmt = `
      INSERT INTO week_coins (
        week_id, coin_id, rank, position, salary,
        power, risk, momentum, momentum_live, metrics_updated_at, momentum_live_updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
        for (const row of rows) {
            await client.query(stmt, [
                row.week_id,
                row.coin_id,
                row.rank,
                row.position,
                row.salary,
                row.power,
                row.risk,
                row.momentum,
                row.momentum_live ?? null,
                row.metrics_updated_at ?? null,
                row.momentum_live_updated_at ?? null,
            ]);
        }
    });
};
export const getWeekCoins = async (weekId) => {
    return queryRead("SELECT * FROM week_coins WHERE week_id = $1 ORDER BY rank ASC", [weekId]);
};
export const updateWeekCoinMomentumLive = async (weekId, coinId, momentumLive, updatedAt) => {
    await queryWrite(`
    UPDATE week_coins
    SET momentum_live = $1, momentum_live_updated_at = $2
    WHERE week_id = $3 AND coin_id = $4
  `, [momentumLive, updatedAt, weekId, coinId]);
};
export const getWeekShowcaseLineup = async (weekId) => {
    const rows = await queryRead("SELECT * FROM week_showcase_lineups WHERE week_id = $1", [weekId]);
    return rows[0] ?? null;
};
export const upsertWeekShowcaseLineup = async (row) => {
    await queryWrite(`
    INSERT INTO week_showcase_lineups (
      week_id, formation_id, slots_json, generated_at, updated_at
    )
    VALUES ($1, $2, $3, $4, now()::text)
    ON CONFLICT(week_id) DO UPDATE SET
      formation_id = EXCLUDED.formation_id,
      slots_json = EXCLUDED.slots_json,
      generated_at = EXCLUDED.generated_at,
      updated_at = now()::text
  `, [row.week_id, row.formation_id, row.slots_json, row.generated_at]);
};
const normalizeAddress = (value) => String(value ?? "").trim().toLowerCase();

// ==================== LINEUPS ====================
export const upsertLineup = async (lineup) => {
    const normalizedAddress = normalizeAddress(lineup.address);
    await withWriteTransaction(async (client) => {
        await client.query(`
    INSERT INTO lineups (
      week_id, address, slots_json, lineup_hash,
      deposit_wei, principal_wei, risk_wei, swaps, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT(week_id, address) DO UPDATE SET
      slots_json = EXCLUDED.slots_json,
      lineup_hash = EXCLUDED.lineup_hash,
      deposit_wei = EXCLUDED.deposit_wei,
      principal_wei = EXCLUDED.principal_wei,
      risk_wei = EXCLUDED.risk_wei,
      swaps = EXCLUDED.swaps,
      created_at = EXCLUDED.created_at
  `, [
            lineup.week_id,
            normalizedAddress,
            lineup.slots_json,
            lineup.lineup_hash,
            lineup.deposit_wei,
            lineup.principal_wei,
            lineup.risk_wei,
            lineup.swaps,
            lineup.created_at,
        ]);

        const strategyRows = await client.query(`
    INSERT INTO strategies (owner_address, display_name)
    VALUES ($1, (SELECT display_name FROM strategist_profiles WHERE address = $1))
    ON CONFLICT(owner_address) DO UPDATE SET
      display_name = COALESCE(
        (SELECT display_name FROM strategist_profiles WHERE address = $1),
        strategies.display_name
      ),
      updated_at = now()::text
    RETURNING strategy_id
  `, [normalizedAddress]);

        const strategyId = strategyRows.rows[0]?.strategy_id;
        if (!strategyId) {
            throw new Error("Failed to resolve strategy identity");
        }

        await client.query(`
    INSERT INTO strategy_epoch_entries (
      epoch_id, strategy_id, lineup_hash, slots_json,
      deposit_wei, principal_wei, risk_wei, swaps, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()::text)
    ON CONFLICT(epoch_id, strategy_id) DO UPDATE SET
      lineup_hash = EXCLUDED.lineup_hash,
      slots_json = EXCLUDED.slots_json,
      deposit_wei = EXCLUDED.deposit_wei,
      principal_wei = EXCLUDED.principal_wei,
      risk_wei = EXCLUDED.risk_wei,
      swaps = EXCLUDED.swaps,
      updated_at = now()::text
  `, [
            lineup.week_id,
            strategyId,
            lineup.lineup_hash,
            lineup.slots_json,
            lineup.deposit_wei,
            lineup.principal_wei,
            lineup.risk_wei,
            lineup.swaps,
            lineup.created_at,
        ]);
    });
};
export const getLineups = async (weekId) => {
    return queryRead("SELECT * FROM lineups WHERE week_id = $1", [weekId]);
};
export const getAllLineups = async () => {
    return queryRead("SELECT * FROM lineups");
};
export const getLineupByAddress = async (weekId, address) => {
    const rows = await queryRead("SELECT * FROM lineups WHERE week_id = $1 AND address = $2", [weekId, address]);
    return rows[0];
};

// ==================== LINEUP TX INTENTS ====================
export const createLineupTxIntent = async (intent) => {
    const rows = await queryWrite(`
    INSERT INTO lineup_tx_intents (
      id, week_id, address, source, slots_json, swap_json,
      status, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'prepared', now()::text, now()::text)
    RETURNING *
  `, [
        intent.id,
        intent.week_id,
        intent.address,
        intent.source,
        intent.slots_json,
        intent.swap_json ?? null,
    ]);
    return rows[0] ?? null;
};
export const getLineupTxIntentById = async (id) => {
    const rows = await queryRead("SELECT * FROM lineup_tx_intents WHERE id = $1", [id]);
    return rows[0] ?? null;
};
export const getLineupTxIntentByTxHash = async (txHash) => {
    const rows = await queryRead("SELECT * FROM lineup_tx_intents WHERE tx_hash = $1", [String(txHash ?? "").toLowerCase()]);
    return rows[0] ?? null;
};
export const markLineupTxIntentSubmitted = async (id, txHash) => {
    const rows = await queryWrite(`
    UPDATE lineup_tx_intents
    SET
      status = CASE WHEN status = 'completed' THEN status ELSE 'submitted' END,
      tx_hash = COALESCE(tx_hash, $2),
      synced = CASE WHEN status = 'completed' THEN synced ELSE 0 END,
      self_heal_task_id = CASE WHEN status = 'completed' THEN self_heal_task_id ELSE null END,
      resolved_at = CASE WHEN status = 'completed' THEN resolved_at ELSE null END,
      updated_at = now()::text,
      last_error = null
    WHERE id = $1
      AND (tx_hash IS NULL OR tx_hash = $2)
    RETURNING *
  `, [id, String(txHash ?? "").toLowerCase()]);
    return rows[0] ?? null;
};
export const markLineupTxIntentHealing = async (id, taskId, errorMessage) => {
    const rows = await queryWrite(`
    UPDATE lineup_tx_intents
    SET
      status = 'submitted',
      synced = 0,
      self_heal_task_id = COALESCE($2, self_heal_task_id),
      last_error = $3,
      resolved_at = null,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [id, taskId ?? null, errorMessage ?? null]);
    return rows[0] ?? null;
};
export const markLineupTxIntentCompleted = async (id, taskId) => {
    const rows = await queryWrite(`
    UPDATE lineup_tx_intents
    SET
      status = 'completed',
      synced = 1,
      self_heal_task_id = COALESCE($2, self_heal_task_id),
      last_error = null,
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [id, taskId ?? null]);
    return rows[0] ?? null;
};
export const markLineupTxIntentFailed = async (id, errorMessage) => {
    const rows = await queryWrite(`
    UPDATE lineup_tx_intents
    SET
      status = 'failed',
      synced = 0,
      last_error = $2,
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [id, errorMessage ?? null]);
    return rows[0] ?? null;
};

export const expireStalePreparedLineupTxIntents = async (olderThanSeconds = 180) => {
    const safeSeconds = Number.isFinite(Number(olderThanSeconds)) && Number(olderThanSeconds) > 0
        ? Math.floor(Number(olderThanSeconds))
        : 180;
    return queryWrite(`
    UPDATE lineup_tx_intents
    SET
      status = 'failed',
      synced = 0,
      last_error = 'intent timed out before tx hash was recorded',
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE status = 'prepared'
      AND tx_hash IS NULL
      AND created_at::timestamptz < now() - ($1 * interval '1 second')
    RETURNING id, week_id, address, source
  `, [safeSeconds]);
};

// ==================== LIFECYCLE TX INTENTS ====================
export const upsertLifecycleTxIntent = async (intent) => {
    const rows = await queryWrite(`
    INSERT INTO lifecycle_tx_intents (
      op_key, week_id, operation, status, details_json, created_at, updated_at
    )
    VALUES ($1, $2, $3, 'prepared', $4, now()::text, now()::text)
    ON CONFLICT(op_key) DO UPDATE SET
      week_id = COALESCE(EXCLUDED.week_id, lifecycle_tx_intents.week_id),
      operation = EXCLUDED.operation,
      details_json = COALESCE(EXCLUDED.details_json, lifecycle_tx_intents.details_json),
      updated_at = now()::text
    RETURNING *
  `, [
        intent.op_key,
        intent.week_id ?? null,
        intent.operation,
        intent.details_json ?? null,
    ]);
    return rows[0] ?? null;
};
export const getLifecycleTxIntentByOpKey = async (opKey) => {
    const rows = await queryRead("SELECT * FROM lifecycle_tx_intents WHERE op_key = $1", [opKey]);
    return rows[0] ?? null;
};
export const countCompletedLifecycleIntents = async (weekId, operation) => {
    const rows = await queryRead(
            `SELECT COUNT(*)::int AS total
        FROM lifecycle_tx_intents
        WHERE week_id = $1
          AND operation = $2
          AND status = 'completed'`,
      [weekId, operation],
    );
    return Number(rows[0]?.total ?? 0);
};
export const markLifecycleTxIntentSubmitted = async (id, txHash, detailsJson) => {
    const rows = await queryWrite(`
    UPDATE lifecycle_tx_intents
    SET
      status = CASE WHEN status = 'completed' THEN status ELSE 'submitted' END,
      tx_hash = COALESCE(tx_hash, $2),
      details_json = COALESCE($3, details_json),
      last_error = null,
      resolved_at = CASE WHEN status = 'completed' THEN resolved_at ELSE null END,
      updated_at = now()::text
    WHERE id = $1
      AND (tx_hash IS NULL OR tx_hash = $2)
    RETURNING *
  `, [id, String(txHash ?? '').toLowerCase(), detailsJson ?? null]);
    return rows[0] ?? null;
};
export const markLifecycleTxIntentCompleted = async (id, detailsJson) => {
    const rows = await queryWrite(`
    UPDATE lifecycle_tx_intents
    SET
      status = 'completed',
      details_json = COALESCE($2, details_json),
      last_error = null,
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [id, detailsJson ?? null]);
    return rows[0] ?? null;
};
export const markLifecycleTxIntentFailed = async (id, errorMessage, detailsJson) => {
    const rows = await queryWrite(`
    UPDATE lifecycle_tx_intents
    SET
      status = 'failed',
      details_json = COALESCE($3, details_json),
      last_error = $2,
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [id, errorMessage ?? null, detailsJson ?? null]);
    return rows[0] ?? null;
};
// ==================== MOCK LINEUPS ====================
export const replaceMockLineups = async (weekId, rows) => {
    await withWriteTransaction(async (client) => {
        await client.query("DELETE FROM mock_lineups WHERE week_id = $1", [weekId]);
        const stmt = `
      INSERT INTO mock_lineups (
        week_id, label, address, formation_id, total_salary, lineup_hash, slots_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (week_id, address) DO UPDATE SET
        label = EXCLUDED.label,
        formation_id = EXCLUDED.formation_id,
        total_salary = EXCLUDED.total_salary,
        lineup_hash = EXCLUDED.lineup_hash,
        slots_json = EXCLUDED.slots_json,
        created_at = now()::text
    `;
        for (const row of rows) {
            await client.query(stmt, [
                row.week_id,
                row.label,
                row.address,
                row.formation_id,
                row.total_salary,
                row.lineup_hash,
                row.slots_json,
            ]);
        }
    });
};
export const getMockLineups = async (weekId) => {
    return queryRead("SELECT * FROM mock_lineups WHERE week_id = $1 ORDER BY label ASC", [weekId]);
};
export const clearMockLineups = async (weekId) => {
    const rows = await queryWrite(`
    WITH deleted AS (
      DELETE FROM mock_lineups
      WHERE week_id = $1
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted_count FROM deleted
  `, [weekId]);
    return Number(rows[0]?.deleted_count ?? 0);
};
export const clearAllMockLineups = async () => {
    const rows = await queryWrite(`
    WITH deleted AS (
      DELETE FROM mock_lineups
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted_count FROM deleted
  `);
    return Number(rows[0]?.deleted_count ?? 0);
};
export const insertMockScoreAggregate = async (row) => {
    await queryWrite(`
    INSERT INTO mock_score_aggregates (
      week_id,
      model_key,
      sample_count,
      wins,
      losses,
      neutral,
      captured_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
        row.week_id,
        row.model_key,
        row.sample_count,
        row.wins,
        row.losses,
        row.neutral,
        row.captured_at,
    ]);
};
export const getMockLineupSnapshotAggregate = async (weekId, modelKey, startAt, endAt) => {
    const rows = await queryRead(`
    SELECT
      COALESCE(SUM(sample_count), 0)::int AS sample_count_sum,
      COUNT(*)::int AS snapshot_count,
      COALESCE(SUM(wins), 0)::int AS wins,
      COALESCE(SUM(losses), 0)::int AS losses,
      COALESCE(SUM(neutral), 0)::int AS neutral,
      MIN(captured_at) AS from_at,
      MAX(captured_at) AS to_at
    FROM mock_score_aggregates
    WHERE week_id = $1
      AND model_key = $2
      AND captured_at >= $3
      AND captured_at <= $4
  `, [weekId, modelKey, startAt, endAt]);
    return (rows[0] ?? {
        sample_count_sum: 0,
        snapshot_count: 0,
        wins: 0,
        losses: 0,
        neutral: 0,
        from_at: null,
        to_at: null,
    });
};
export const getLatestMockLineupSnapshotAt = async (weekId, modelKey) => {
    const rows = await queryRead(`
    SELECT captured_at
    FROM mock_score_aggregates
    WHERE week_id = $1
      AND model_key = $2
    ORDER BY captured_at DESC
    LIMIT 1
  `, [weekId, modelKey]);
    return rows[0]?.captured_at ?? null;
};
export const clearMockScoreAggregates = async () => {
    const rows = await queryWrite(`
    WITH deleted AS (
      DELETE FROM mock_score_aggregates
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted_count FROM deleted
  `);
    return Number(rows[0]?.deleted_count ?? 0);
};
export const getStrategyById = async (strategyId) => {
    const rows = await queryRead(`
    SELECT
      s.strategy_id,
      s.owner_address AS address,
      COALESCE(s.display_name, pp.display_name) AS display_name,
      s.created_at,
      s.updated_at,
      COALESCE(stats.epochs_played, 0)::int AS epochs_played,
      COALESCE(stats.avg_score, 0) AS avg_score,
      COALESCE(stats.total_score, 0) AS total_score,
      COALESCE(stats.best_score, 0) AS best_score
    FROM strategies s
    LEFT JOIN strategist_profiles pp
      ON LOWER(pp.address) = LOWER(s.owner_address)
    LEFT JOIN (
      SELECT
        strategy_id,
        COUNT(*)::int AS epochs_played,
        AVG(COALESCE(score, 0)) AS avg_score,
        SUM(COALESCE(score, 0)) AS total_score,
        MAX(COALESCE(score, 0)) AS best_score
      FROM strategy_epoch_entries
      GROUP BY strategy_id
    ) stats
      ON stats.strategy_id = s.strategy_id
    WHERE s.strategy_id = $1
    LIMIT 1
  `, [strategyId]);
    return rows[0] ?? null;
};

export const getStrategyEpochEntries = async (strategyId, limit = 20) => {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return queryRead(`
    SELECT
      se.epoch_id,
      se.strategy_id,
      CASE WHEN UPPER(COALESCE(w.status, '')) = 'FINALIZED' THEN se.lineup_hash ELSE NULL END AS lineup_hash,
      CASE WHEN UPPER(COALESCE(w.status, '')) = 'FINALIZED' THEN se.slots_json ELSE NULL END AS slots_json,
      se.deposit_wei,
      se.principal_wei,
      se.risk_wei,
      se.swaps,
      se.score,
      se.rank,
      se.reward_wei,
      se.season_id,
      se.season_points,
      se.created_at,
      se.updated_at
    FROM strategy_epoch_entries se
    LEFT JOIN weeks w
      ON w.id = se.epoch_id
    WHERE se.strategy_id = $1
    ORDER BY se.epoch_id::bigint DESC
    LIMIT $2
  `, [strategyId, safeLimit]);
};

export const getEpochStrategies = async (epochId, options = {}) => {
    const limit = Math.max(1, Math.min(100, Number(options.limit ?? 50) || 50));
    const offset = Math.max(0, Number(options.offset ?? 0) || 0);
    const rows = await queryRead(`
    SELECT
      ranked.rank,
      ranked.epoch_id,
      ranked.strategy_id,
      ranked.address,
      ranked.display_name,
      ranked.lineup_hash,
      ranked.deposit_wei,
      ranked.principal_wei,
      ranked.risk_wei,
      ranked.swaps,
      ranked.score,
      ranked.reward_wei,
      ranked.created_at,
      ranked.updated_at,
      COUNT(*) OVER()::int AS total_count
    FROM (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            CASE WHEN se.rank IS NULL THEN 1 ELSE 0 END ASC,
            se.rank ASC NULLS LAST,
            se.score DESC NULLS LAST,
            se.strategy_id ASC
        ) AS rank,
        se.epoch_id,
        se.strategy_id,
        s.owner_address AS address,
        COALESCE(s.display_name, pp.display_name) AS display_name,
        CASE WHEN UPPER(COALESCE(w.status, '')) = 'FINALIZED' THEN se.lineup_hash ELSE NULL END AS lineup_hash,
        se.deposit_wei,
        se.principal_wei,
        se.risk_wei,
        se.swaps,
        se.score,
        se.reward_wei,
        se.created_at,
        se.updated_at
      FROM strategy_epoch_entries se
      INNER JOIN strategies s
        ON s.strategy_id = se.strategy_id
      LEFT JOIN strategist_profiles pp
        ON LOWER(pp.address) = LOWER(s.owner_address)
      LEFT JOIN weeks w
        ON w.id = se.epoch_id
      WHERE se.epoch_id = $1
    ) ranked
    ORDER BY ranked.rank ASC
    LIMIT $2 OFFSET $3
  `, [epochId, limit, offset]);

    const total = rows[0]?.total_count ?? 0;
    return {
        total,
        rows: rows.map((row) => {
            const { total_count, ...rest } = row;
            return rest;
        }),
    };
};

const normalizeLeaderboardScope = (scope) => {
    const normalized = String(scope ?? "").trim().toLowerCase();
    if (normalized === "season") {
        return "season";
    }
    return "all_time";
};

const resolveSeasonId = async (seasonId) => {
    const explicit = String(seasonId ?? "").trim();
    if (explicit) {
        return explicit;
    }
    const rows = await queryRead(`
    SELECT
      CONCAT(
        EXTRACT(isoyear FROM w.start_at::timestamptz)::int,
        '-S',
        (((EXTRACT(week FROM w.start_at::timestamptz)::int - 1) / 12) + 1)::int
      )::text AS season_id
    FROM weeks w
    ORDER BY w.start_at::timestamptz DESC
    LIMIT 1
  `);
    const resolved = String(rows[0]?.season_id ?? "").trim();
    return resolved || null;
};

export const getStrategySeasonEntries = async (strategyId, limit = 8) => {
    const safeLimit = Math.max(1, Math.min(24, Number(limit) || 8));
    return queryRead(`
    SELECT
      season_id,
      strategy_id,
      season_points,
      epochs_played,
      wins,
      top10,
      avg_score,
      total_score,
      best_rank,
      updated_at
    FROM strategy_season_entries
    WHERE strategy_id = $1
    ORDER BY season_id DESC
    LIMIT $2
  `, [strategyId, safeLimit]);
};

export const getSeasonStrategies = async (seasonId, options = {}) => {
    const normalizedSeasonId = String(seasonId ?? "").trim();
    if (!normalizedSeasonId) {
        return {
            seasonId: null,
            total: 0,
            rows: [],
        };
    }

    const limit = Math.max(1, Math.min(100, Number(options.limit ?? 50) || 50));
    const offset = Math.max(0, Number(options.offset ?? 0) || 0);
    const rows = await queryRead(`
    SELECT
      ranked.rank,
      ranked.season_id,
      ranked.strategy_id,
      ranked.address,
      ranked.display_name,
      ranked.season_points,
      ranked.epochs_played,
      ranked.wins,
      ranked.top10,
      ranked.avg_score,
      ranked.total_score,
      ranked.best_rank,
      COUNT(*) OVER()::int AS total_count
    FROM (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            sse.season_points DESC,
            sse.wins DESC,
            sse.total_score DESC,
            sse.strategy_id ASC
        ) AS rank,
        sse.season_id,
        sse.strategy_id,
        s.owner_address AS address,
        COALESCE(s.display_name, pp.display_name) AS display_name,
        sse.season_points,
        sse.epochs_played,
        sse.wins,
        sse.top10,
        sse.avg_score,
        sse.total_score,
        sse.best_rank
      FROM strategy_season_entries sse
      INNER JOIN strategies s
        ON s.strategy_id = sse.strategy_id
      LEFT JOIN strategist_profiles pp
        ON LOWER(pp.address) = LOWER(s.owner_address)
      WHERE sse.season_id = $1
    ) ranked
    ORDER BY ranked.rank ASC
    LIMIT $2 OFFSET $3
  `, [normalizedSeasonId, limit, offset]);

    const total = rows[0]?.total_count ?? 0;
    return {
        seasonId: normalizedSeasonId,
        total,
        rows: rows.map((row) => {
            const { total_count, ...rest } = row;
            return rest;
        }),
    };
};

export const getStrategyLeaderboardRows = async (options = {}) => {
    const epochId = String(options.epochId ?? "").trim();
    const scope = normalizeLeaderboardScope(options.scope);
    const seasonId = String(options.seasonId ?? "").trim();
    const limit = Math.max(1, Math.min(100, Number(options.limit ?? 50) || 50));
    const offset = Math.max(0, Number(options.offset ?? 0) || 0);

    if (epochId) {
        return getEpochStrategies(epochId, { limit, offset });
    }

    if (scope === "season") {
        const resolvedSeasonId = await resolveSeasonId(seasonId);
        if (!resolvedSeasonId) {
            return {
                seasonId: null,
                total: 0,
                rows: [],
            };
        }
        return getSeasonStrategies(resolvedSeasonId, { limit, offset });
    }

    const rows = await queryRead(`
    SELECT
      ranked.rank,
      ranked.strategy_id,
      ranked.address,
      ranked.display_name,
      ranked.epochs_played,
      ranked.avg_score,
      ranked.total_score,
      ranked.best_score,
      ranked.avg_swaps,
      COUNT(*) OVER()::int AS total_count
    FROM (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            SUM(COALESCE(se.score, 0)) DESC,
            COUNT(*) DESC,
            se.strategy_id ASC
        ) AS rank,
        se.strategy_id,
        s.owner_address AS address,
        COALESCE(s.display_name, pp.display_name) AS display_name,
        COUNT(*)::int AS epochs_played,
        AVG(COALESCE(se.score, 0)) AS avg_score,
        SUM(COALESCE(se.score, 0)) AS total_score,
        MAX(COALESCE(se.score, 0)) AS best_score,
        AVG(COALESCE(se.swaps, 0)) AS avg_swaps
      FROM strategy_epoch_entries se
      INNER JOIN strategies s
        ON s.strategy_id = se.strategy_id
      LEFT JOIN strategist_profiles pp
        ON LOWER(pp.address) = LOWER(s.owner_address)
      GROUP BY se.strategy_id, s.owner_address, COALESCE(s.display_name, pp.display_name)
    ) ranked
    ORDER BY ranked.rank ASC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

    const total = rows[0]?.total_count ?? 0;
    return {
        seasonId: null,
        total,
        rows: rows.map((row) => {
            const { total_count, ...rest } = row;
            return rest;
        }),
    };
};

export const syncStrategyEpochScoresForWeek = async (weekId) => {
    const targetWeekId = String(weekId ?? "").trim();
    if (!targetWeekId) {
        return;
    }

    await withWriteTransaction(async (client) => {
        await client.query(`
      INSERT INTO strategies (owner_address, display_name)
      SELECT
        LOWER(l.address) AS owner_address,
        MAX(pp.display_name) AS display_name
      FROM lineups l
      LEFT JOIN strategist_profiles pp
        ON LOWER(pp.address) = LOWER(l.address)
      WHERE l.week_id = $1
      GROUP BY LOWER(l.address)
      ON CONFLICT(owner_address) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, strategies.display_name),
        updated_at = now()::text
    `, [targetWeekId]);

        await client.query(`
      INSERT INTO strategy_epoch_entries (
        epoch_id, strategy_id, lineup_hash, slots_json,
        deposit_wei, principal_wei, risk_wei, swaps, created_at, updated_at
      )
      SELECT
        l.week_id AS epoch_id,
        s.strategy_id,
        l.lineup_hash,
        l.slots_json,
        l.deposit_wei,
        l.principal_wei,
        l.risk_wei,
        l.swaps,
        l.created_at,
        now()::text
      FROM lineups l
      INNER JOIN strategies s
        ON LOWER(s.owner_address) = LOWER(l.address)
      WHERE l.week_id = $1
      ON CONFLICT(epoch_id, strategy_id) DO UPDATE SET
        lineup_hash = EXCLUDED.lineup_hash,
        slots_json = EXCLUDED.slots_json,
        deposit_wei = EXCLUDED.deposit_wei,
        principal_wei = EXCLUDED.principal_wei,
        risk_wei = EXCLUDED.risk_wei,
        swaps = EXCLUDED.swaps,
        updated_at = now()::text
    `, [targetWeekId]);

        await client.query(`
      WITH ranked AS (
        SELECT
          wr.week_id AS epoch_id,
          s.strategy_id,
          wr.final_score,
          wr.reward_amount_wei,
          ROW_NUMBER() OVER (ORDER BY wr.final_score DESC, wr.address ASC) AS rank
        FROM weekly_results wr
        INNER JOIN strategies s
          ON LOWER(s.owner_address) = LOWER(wr.address)
        WHERE wr.week_id = $1
      )
      UPDATE strategy_epoch_entries se
      SET
        score = ranked.final_score,
        rank = ranked.rank,
        reward_wei = ranked.reward_amount_wei,
        updated_at = now()::text
      FROM ranked
      WHERE se.epoch_id = ranked.epoch_id
        AND se.strategy_id = ranked.strategy_id
    `, [targetWeekId]);

        const seasonRows = await client.query(`
      SELECT
        CONCAT(
          EXTRACT(isoyear FROM w.start_at::timestamptz)::int,
          '-S',
          (((EXTRACT(week FROM w.start_at::timestamptz)::int - 1) / 12) + 1)::int
        )::text AS season_id
      FROM weeks w
      WHERE w.id = $1
      LIMIT 1
    `, [targetWeekId]);

        const seasonId = String(seasonRows.rows[0]?.season_id ?? "").trim();
        if (!seasonId) {
            return;
        }

        await client.query(`
      UPDATE strategy_epoch_entries se
      SET
        season_id = $2,
        season_points = CASE
          WHEN se.rank = 1 THEN 100
          WHEN se.rank = 2 THEN 80
          WHEN se.rank = 3 THEN 60
          WHEN se.rank = 4 THEN 50
          WHEN se.rank = 5 THEN 40
          WHEN se.rank BETWEEN 6 AND 10 THEN 25
          WHEN se.rank BETWEEN 11 AND 25 THEN 10
          ELSE 0
        END,
        updated_at = now()::text
      WHERE se.epoch_id = $1
    `, [targetWeekId, seasonId]);

        await client.query(`
      INSERT INTO strategy_season_entries (
        season_id,
        strategy_id,
        season_points,
        epochs_played,
        wins,
        top10,
        avg_score,
        total_score,
        best_rank,
        created_at,
        updated_at
      )
      SELECT
        se.season_id,
        se.strategy_id,
        COALESCE(SUM(COALESCE(se.season_points, 0)), 0)::int AS season_points,
        COUNT(*)::int AS epochs_played,
        COUNT(*) FILTER (WHERE se.rank = 1)::int AS wins,
        COUNT(*) FILTER (WHERE se.rank BETWEEN 1 AND 10)::int AS top10,
        AVG(COALESCE(se.score, 0)) AS avg_score,
        SUM(COALESCE(se.score, 0)) AS total_score,
        MIN(se.rank) FILTER (WHERE se.rank IS NOT NULL) AS best_rank,
        now()::text,
        now()::text
      FROM strategy_epoch_entries se
      WHERE se.season_id = $1
      GROUP BY se.season_id, se.strategy_id
      ON CONFLICT(season_id, strategy_id) DO UPDATE SET
        season_points = EXCLUDED.season_points,
        epochs_played = EXCLUDED.epochs_played,
        wins = EXCLUDED.wins,
        top10 = EXCLUDED.top10,
        avg_score = EXCLUDED.avg_score,
        total_score = EXCLUDED.total_score,
        best_rank = EXCLUDED.best_rank,
        updated_at = now()::text
    `, [seasonId]);

        await client.query(`
      DELETE FROM strategy_season_entries sse
      WHERE sse.season_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM strategy_epoch_entries se
          WHERE se.season_id = sse.season_id
            AND se.strategy_id = sse.strategy_id
        )
    `, [seasonId]);
    });
};

// ==================== WEEKLY RESULTS ====================
export const getWeeklyResults = async (weekId) => {
    return queryRead("SELECT * FROM weekly_results WHERE week_id = $1", [
        weekId,
    ]);
};
export const getLeaderboardRows = async (weekId) => {
    return queryRead(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY wr.final_score DESC, wr.address ASC) AS rank,
      wr.week_id,
      wr.lineup_id,
      wr.address,
      wr.raw_performance,
      wr.efficiency_multiplier,
      wr.final_score,
      wr.reward_amount_wei,
      wr.created_at,
      COALESCE(l.deposit_wei, '0') AS deposit_wei,
      COALESCE(l.principal_wei, '0') AS principal_wei,
      COALESCE(l.risk_wei, '0') AS risk_wei,
      COALESCE(l.swaps, 0) AS swaps,
      pp.display_name
    FROM weekly_results wr
    LEFT JOIN lineups l
      ON l.week_id = wr.week_id
      AND LOWER(l.address) = LOWER(wr.address)
    LEFT JOIN strategist_profiles pp
      ON LOWER(pp.address) = LOWER(wr.address)
    WHERE wr.week_id = $1
    ORDER BY wr.final_score DESC, wr.address ASC
  `, [weekId]);
};
export const getAllWeeklyResults = async () => {
    return queryRead("SELECT * FROM weekly_results");
};
export const getSwapLogByWeek = async (weekId) => {
    return queryRead("SELECT * FROM swap_log WHERE week_id = $1 ORDER BY swap_timestamp DESC", [weekId]);
};

// ==================== FAUCET CLAIMS ====================
export const getFaucetClaim = async (address) => {
    const rows = await queryRead("SELECT * FROM faucet_claims WHERE address = $1", [address]);
    return rows[0];
};
export const upsertFaucetClaim = async (claim) => {
    await queryWrite(`
    INSERT INTO faucet_claims (address, last_claim_at, last_tx_hash)
    VALUES ($1, $2, $3)
    ON CONFLICT(address) DO UPDATE SET
      last_claim_at = EXCLUDED.last_claim_at,
      last_tx_hash = EXCLUDED.last_tx_hash
  `, [claim.address, claim.last_claim_at, claim.last_tx_hash ?? null]);
};
export const getPlayerProfile = async (address) => {
    const rows = await queryRead("SELECT * FROM strategist_profiles WHERE address = $1", [address]);
    return rows[0] ?? null;
};
export const getPlayerProfileByDisplayName = async (displayName) => {
    const rows = await queryRead("SELECT * FROM strategist_profiles WHERE LOWER(display_name) = LOWER($1) LIMIT 1", [displayName]);
    return rows[0] ?? null;
};
export const getPlayerProfilesByAddresses = async (addresses) => {
    const normalized = Array.from(new Set((addresses ?? [])
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter((value) => value.length > 0)));
    if (!normalized.length) {
        return [];
    }
    return queryRead("SELECT * FROM strategist_profiles WHERE address = ANY($1)", [normalized]);
};
export const upsertPlayerProfile = async (profile) => {
    const rows = await queryWrite(`
    INSERT INTO strategist_profiles (address, display_name)
    VALUES ($1, $2)
    ON CONFLICT(address) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      updated_at = now()::text
    RETURNING *
  `, [profile.address, profile.display_name]);
    return rows[0] ?? null;
};

const toErrorSeverityRank = (severity) => {
    const normalized = String(severity ?? "").trim().toLowerCase();
    if (normalized === "fatal")
        return 3;
    if (normalized === "error")
        return 2;
    if (normalized === "warn")
        return 1;
    return 0;
};

const INCIDENT_STATES = new Set(["new", "actionable", "suppressed", "fixed-monitoring", "closed"]);

const toPositiveIntOr = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
};

const INCIDENT_WINDOW_MINUTES = toPositiveIntOr(process.env.ERROR_INCIDENT_WINDOW_MINUTES, 10);
const INCIDENT_THRESHOLD = toPositiveIntOr(process.env.ERROR_INCIDENT_THRESHOLD, 3);
const INCIDENT_MONITOR_MINUTES = toPositiveIntOr(process.env.ERROR_INCIDENT_MONITOR_MINUTES, 1440);

const normalizeForIncident = (value) => String(value ?? "").trim().toLowerCase();

const buildIncidentKey = (event) => {
    const source = normalizeForIncident(event.source) || "web-client";
    const fingerprint = normalizeForIncident(event.fingerprint);
    if (fingerprint) {
        return `${source}|${fingerprint}`;
    }
    const category = normalizeForIncident(event.category) || "runtime";
    const method = normalizeForIncident(event.method) || "na";
    const path = normalizeForIncident(event.path) || "na";
    const status = Number.isFinite(Number(event.status_code ?? event.statusCode)) ? String(event.status_code ?? event.statusCode) : "na";
    const message = normalizeForIncident(event.message).slice(0, 120) || "na";
    return `${source}|${category}|${method}|${path}|${status}|${message}`;
};

const isCriticalErrorRoute = (event) => {
    const path = String(event.path ?? "").trim().toLowerCase();
    const category = String(event.category ?? "").trim().toLowerCase();
    if (path.startsWith("/admin/jobs"))
        return true;
    if (category === "unhandled")
        return true;
    if (category === "wallet-approve")
        return true;
    return false;
};

const findMatchingSuppressRule = async (event) => {
    const source = String(event.source ?? "").trim();
    const category = String(event.category ?? "").trim();
    const fingerprint = String(event.fingerprint ?? "").trim();
    const path = String(event.path ?? "").trim();
    const method = String(event.method ?? "").trim();
    const statusCode = Number.isFinite(Number(event.status_code ?? event.statusCode)) ? Number(event.status_code ?? event.statusCode) : null;
    const message = String(event.message ?? "").trim();
    const severity = String(event.severity ?? "").trim();

    const rows = await queryRead(`
    SELECT *
    FROM error_suppress_rules
    WHERE enabled = 1
      AND (source IS NULL OR LOWER(source) = LOWER($1::text))
      AND (category IS NULL OR LOWER(category) = LOWER($2::text))
      AND (fingerprint IS NULL OR LOWER(fingerprint) = LOWER($3::text))
      AND (path_pattern IS NULL OR ($4::text <> '' AND $4::text ILIKE path_pattern))
      AND (method IS NULL OR LOWER(method) = LOWER($5::text))
      AND (status_code IS NULL OR ($6::int IS NOT NULL AND status_code = $6::int))
      AND (message_pattern IS NULL OR ($7::text <> '' AND $7::text ILIKE message_pattern))
      AND (severity IS NULL OR LOWER(severity) = LOWER($8::text))
    ORDER BY
      CASE WHEN fingerprint IS NULL THEN 1 ELSE 0 END,
      CASE WHEN path_pattern IS NULL THEN 1 ELSE 0 END,
      id ASC
    LIMIT 1
  `, [source, category, fingerprint, path, method, statusCode, message, severity]);

    return rows[0] ?? null;
};

const countIncidentEventsInWindow = async (incidentKey, sinceIso) => {
    const rows = await queryRead(`
    SELECT COUNT(*)::int AS total
    FROM error_events
    WHERE incident_key = $1
      AND suppressed = 0
      AND created_at >= $2
  `, [incidentKey, sinceIso]);
    return Number(rows[0]?.total ?? 0);
};

const resolveIncidentStateForEvent = ({ suppressed, actionable }) => {
    if (suppressed)
        return "suppressed";
    if (actionable)
        return "actionable";
    return "new";
};

const refreshIncidentAggregate = async (incidentKey) => {
    const key = String(incidentKey ?? "").trim();
    if (!key)
        return null;

    const statsRows = await queryRead(`
    SELECT
      COUNT(*)::int AS event_count,
      COUNT(*) FILTER (WHERE acknowledged = 0)::int AS unacked_count,
      COUNT(*) FILTER (WHERE acknowledged = 0 AND actionable = 1)::int AS unacked_actionable,
      COUNT(*) FILTER (WHERE acknowledged = 0 AND suppressed = 1)::int AS unacked_suppressed,
      MAX(created_at) AS last_seen_at,
      MAX(id) AS last_error_event_id,
      MIN(created_at) AS first_seen_at,
      MAX(source) AS source,
      MAX(fingerprint) AS fingerprint,
      MAX(category) AS category,
      MAX(path) AS path,
      MAX(method) AS method,
      MAX(status_code) AS status_code
    FROM error_events
    WHERE incident_key = $1
  `, [key]);
    const stats = statsRows[0] ?? null;
    if (!stats || Number(stats.event_count ?? 0) <= 0) {
        return null;
    }

    const currentRows = await queryRead("SELECT * FROM error_incidents WHERE incident_key = $1", [key]);
    const current = currentRows[0] ?? null;
    if (!current) {
        return null;
    }

    const unackedCount = Number(stats.unacked_count ?? 0);
    const unackedActionable = Number(stats.unacked_actionable ?? 0);
    const unackedSuppressed = Number(stats.unacked_suppressed ?? 0);

    let nextState = String(current.current_state ?? "new");
    let monitorUntilAt = current.monitor_until_at ?? null;

    if (unackedCount <= 0) {
        if (nextState !== "suppressed" && nextState !== "closed") {
            nextState = "fixed-monitoring";
            monitorUntilAt = new Date(Date.now() + INCIDENT_MONITOR_MINUTES * 60000).toISOString();
        }
    }
    else if (unackedActionable > 0) {
        nextState = "actionable";
        monitorUntilAt = null;
    }
    else if (unackedSuppressed > 0 && unackedSuppressed === unackedCount) {
        nextState = "suppressed";
    }
    else {
        nextState = "new";
        monitorUntilAt = null;
    }

    const escalationState = nextState === "actionable" ? "pending-disabled" : "idle";

    const rows = await queryWrite(`
    UPDATE error_incidents
    SET
      source = COALESCE($2, source),
      fingerprint = COALESCE($3, fingerprint),
      category = COALESCE($4, category),
      path = COALESCE($5, path),
      method = COALESCE($6, method),
      status_code = COALESCE($7, status_code),
      first_seen_at = COALESCE($8, first_seen_at),
      last_seen_at = COALESCE($9, last_seen_at),
      event_count = $10,
      unacked_count = $11,
      last_error_event_id = COALESCE($12, last_error_event_id),
      current_state = $13,
      monitor_until_at = $14,
      escalation_state = $15,
      updated_at = now()::text
    WHERE incident_key = $1
    RETURNING *
  `, [
      key,
      stats.source ?? null,
      stats.fingerprint ?? null,
      stats.category ?? null,
      stats.path ?? null,
      stats.method ?? null,
      stats.status_code ?? null,
      stats.first_seen_at ?? null,
      stats.last_seen_at ?? null,
      Number(stats.event_count ?? 0),
      unackedCount,
      stats.last_error_event_id ?? null,
      nextState,
      monitorUntilAt,
      escalationState,
    ]);

    return rows[0] ?? null;
};

const upsertIncidentFromEvent = async ({ eventRow, suppressRuleId, eventState, actionable }) => {
    const key = String(eventRow.incident_key ?? "").trim();
    if (!key)
        return null;

    const existingRows = await queryRead("SELECT * FROM error_incidents WHERE incident_key = $1", [key]);
    const existing = existingRows[0] ?? null;

    const nowIso = eventRow.created_at ?? new Date().toISOString();
    const source = String(eventRow.source ?? "");
    const fingerprint = eventRow.fingerprint ?? null;
    const category = eventRow.category ?? null;
    const path = eventRow.path ?? null;
    const method = eventRow.method ?? null;
    const statusCode = eventRow.status_code ?? null;
    const unackedDelta = Number(eventRow.acknowledged ?? 0) === 1 ? 0 : 1;

    if (!existing) {
        const escalationState = eventState === "actionable" ? "pending-disabled" : "idle";
        const rows = await queryWrite(`
      INSERT INTO error_incidents (
        incident_key, source, fingerprint, category, path, method, status_code,
        current_state, first_seen_at, last_seen_at,
        event_count, unacked_count, last_error_event_id,
        suppression_rule_id, monitor_until_at, regression_count,
        escalation_state, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, now()::text, now()::text
      )
      RETURNING *
    `, [
            key,
            source,
            fingerprint,
            category,
            path,
            method,
            statusCode,
            eventState,
            nowIso,
            nowIso,
            1,
            unackedDelta,
            eventRow.id ?? null,
            suppressRuleId ?? null,
            null,
            0,
            escalationState,
        ]);
        return rows[0] ?? null;
    }

    let nextState = eventState;
    let regressionBump = 0;
    const currentState = String(existing.current_state ?? "new");
    const isSuppressed = eventState === "suppressed";

    if (!isSuppressed && currentState === "fixed-monitoring") {
        nextState = "actionable";
        regressionBump = 1;
    }

    if (!isSuppressed && currentState === "suppressed" && !actionable) {
        nextState = "new";
    }

    const escalationState = nextState === "actionable" ? "pending-disabled" : "idle";

    const rows = await queryWrite(`
    UPDATE error_incidents
    SET
      source = COALESCE($2, source),
      fingerprint = COALESCE($3, fingerprint),
      category = COALESCE($4, category),
      path = COALESCE($5, path),
      method = COALESCE($6, method),
      status_code = COALESCE($7, status_code),
      current_state = $8,
      last_seen_at = $9,
      event_count = event_count + 1,
      unacked_count = unacked_count + $10,
      last_error_event_id = COALESCE($11, last_error_event_id),
      suppression_rule_id = COALESCE($12, suppression_rule_id),
      monitor_until_at = CASE WHEN $8 = 'fixed-monitoring' THEN monitor_until_at ELSE NULL END,
      regression_count = regression_count + $13,
      escalation_state = $14,
      updated_at = now()::text
    WHERE incident_key = $1
    RETURNING *
  `, [
        key,
        source,
        fingerprint,
        category,
        path,
        method,
        statusCode,
        nextState,
        nowIso,
        unackedDelta,
        eventRow.id ?? null,
        suppressRuleId ?? null,
        regressionBump,
        escalationState,
    ]);

    return rows[0] ?? null;
};

export const insertErrorEvent = async (event) => {
    const incidentKey = buildIncidentKey(event);
    const suppressRule = await findMatchingSuppressRule(event);
    const suppressed = suppressRule ? 1 : 0;

    const sinceIso = new Date(Date.now() - INCIDENT_WINDOW_MINUTES * 60000).toISOString();
    const recentCount = await countIncidentEventsInWindow(incidentKey, sinceIso);
    const severityRank = toErrorSeverityRank(event.severity ?? "error");
    const critical = isCriticalErrorRoute(event);
    const actionable = suppressed
        ? 0
        : severityRank >= 2 && (critical || recentCount + 1 >= INCIDENT_THRESHOLD)
            ? 1
            : 0;

    const incidentState = resolveIncidentStateForEvent({
        suppressed: suppressed === 1,
        actionable: actionable === 1,
    });

    const rows = await queryWrite(`
    INSERT INTO error_events (
      event_id, source, severity, category, message,
      error_name, stack, fingerprint, path, method,
      status_code, context_json, tags_json, release,
      session_address, wallet_address, strategist_display_name, user_agent, ip_address,
      acknowledged, acknowledged_by, acknowledged_at, created_at,
      incident_key, incident_state, actionable, suppressed, suppression_reason, regression, escalation_state
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18, $19,
      $20, $21, $22, $23,
      $24, $25, $26, $27, $28, $29, $30
    )
    RETURNING *
  `, [
        event.event_id ?? null,
        event.source,
        event.severity,
        event.category,
        event.message,
        event.error_name ?? null,
        event.stack ?? null,
        event.fingerprint ?? null,
        event.path ?? null,
        event.method ?? null,
        event.status_code ?? null,
        event.context_json ?? null,
        event.tags_json ?? null,
        event.release ?? null,
        event.session_address ?? null,
        event.wallet_address ?? null,
        event.strategist_display_name ?? null,
        event.user_agent ?? null,
        event.ip_address ?? null,
        event.acknowledged ?? 0,
        event.acknowledged_by ?? null,
        event.acknowledged_at ?? null,
        event.created_at ?? new Date().toISOString(),
        incidentKey,
        incidentState,
        actionable,
        suppressed,
        suppressRule ? String(suppressRule.name ?? `rule-${suppressRule.id}`) : null,
        0,
        actionable ? "pending-disabled" : "idle",
    ]);

    const row = rows[0] ?? null;
    if (!row) {
        return null;
    }

    await upsertIncidentFromEvent({
        eventRow: row,
        suppressRuleId: suppressRule?.id ?? null,
        eventState: incidentState,
        actionable: actionable === 1,
    });

    return row;
};

export const listErrorEvents = async (options = {}) => {
    const limit = Math.max(1, Math.min(100, Number(options.limit ?? 25) || 25));
    const offset = Math.max(0, Number(options.offset ?? 0) || 0);
    const where = [];
    const params = [];
    let index = 1;

    if (options.severity) {
        where.push(`LOWER(severity) = LOWER($${index++})`);
        params.push(String(options.severity));
    }
    if (options.source) {
        where.push(`LOWER(source) = LOWER($${index++})`);
        params.push(String(options.source));
    }
    if (options.category) {
        where.push(`LOWER(category) = LOWER($${index++})`);
        params.push(String(options.category));
    }
    if (options.acknowledged === "acked") {
        where.push(`acknowledged = 1`);
    }
    if (options.acknowledged === "unacked") {
        where.push(`acknowledged = 0`);
    }
    if (options.actionable === "actionable") {
        where.push(`actionable = 1`);
    }
    if (options.actionable === "non-actionable") {
        where.push(`actionable = 0`);
    }
    if (options.incidentState) {
        where.push(`LOWER(incident_state) = LOWER($${index++})`);
        params.push(String(options.incidentState));
    }

    const search = String(options.search ?? "").trim();
    if (search) {
        where.push(`(
      message ILIKE $${index}
      OR COALESCE(error_name, '') ILIKE $${index}
      OR COALESCE(fingerprint, '') ILIKE $${index}
      OR COALESCE(incident_key, '') ILIKE $${index}
      OR COALESCE(path, '') ILIKE $${index}
      OR COALESCE(session_address, '') ILIKE $${index}
      OR COALESCE(wallet_address, '') ILIKE $${index}
      OR COALESCE(strategist_display_name, '') ILIKE $${index}
    )`);
        params.push(`%${search}%`);
        index += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await queryRead(`
    SELECT *, COUNT(*) OVER()::int AS total_count
    FROM error_events
    ${whereSql}
    ORDER BY
      CASE LOWER(incident_state)
        WHEN 'actionable' THEN 0
        WHEN 'new' THEN 1
        WHEN 'fixed-monitoring' THEN 2
        WHEN 'suppressed' THEN 3
        WHEN 'closed' THEN 4
        ELSE 5
      END ASC,
      created_at DESC,
      id DESC
    LIMIT $${index} OFFSET $${index + 1}
  `, [...params, limit, offset]);

    const total = rows[0]?.total_count ?? 0;
    return {
        total,
        rows: rows.map((row) => {
            const { total_count, ...rest } = row;
            return rest;
        }),
    };
};

export const getErrorEventById = async (id) => {
    const rows = await queryRead("SELECT * FROM error_events WHERE id = $1", [id]);
    return rows[0] ?? null;
};

export const acknowledgeErrorEvent = async (id, acknowledgedBy) => {
    const targetRows = await queryRead("SELECT id, source, fingerprint, incident_key FROM error_events WHERE id = $1", [id]);
    const target = targetRows[0] ?? null;
    if (!target) {
        return null;
    }

    const actor = acknowledgedBy ?? null;
    const fingerprint = String(target.fingerprint ?? "").trim();
    const source = String(target.source ?? "").trim();
    let affected = 0;
    let mode = "single";
    let touchedKeys = [];

    if (fingerprint && source) {
        const rows = await queryWrite(`
      UPDATE error_events
      SET
        acknowledged = 1,
        acknowledged_by = COALESCE($4, acknowledged_by),
        acknowledged_at = COALESCE(acknowledged_at, now()::text)
      WHERE fingerprint = $1
        AND source = $2
        AND id <= $3
        AND acknowledged = 0
      RETURNING id, incident_key
    `, [fingerprint, source, id, actor]);
        affected = rows.length;
        mode = "fingerprint-history";
        touchedKeys = rows.map((row) => String(row.incident_key ?? "").trim()).filter(Boolean);
    }
    else {
        const rows = await queryWrite(`
      UPDATE error_events
      SET
        acknowledged = 1,
        acknowledged_by = COALESCE($2, acknowledged_by),
        acknowledged_at = COALESCE(acknowledged_at, now()::text)
      WHERE id = $1
      RETURNING id, incident_key
    `, [id, actor]);
        affected = rows.length;
        touchedKeys = rows.map((row) => String(row.incident_key ?? "").trim()).filter(Boolean);
    }

    for (const incidentKey of Array.from(new Set(touchedKeys))) {
        await refreshIncidentAggregate(incidentKey);
    }

    const latestRows = await queryRead("SELECT * FROM error_events WHERE id = $1", [id]);
    const row = latestRows[0] ?? null;
    if (!row) {
        return null;
    }

    return { row, affected, mode };
};

export const listErrorIncidents = async (options = {}) => {
    const limit = Math.max(1, Math.min(100, Number(options.limit ?? 25) || 25));
    const offset = Math.max(0, Number(options.offset ?? 0) || 0);
    const where = [];
    const params = [];
    let index = 1;

    if (options.state) {
        where.push(`LOWER(current_state) = LOWER($${index++})`);
        params.push(String(options.state));
    }
    if (options.source) {
        where.push(`LOWER(source) = LOWER($${index++})`);
        params.push(String(options.source));
    }
    const search = String(options.search ?? "").trim();
    if (search) {
        where.push(`(
      incident_key ILIKE $${index}
      OR COALESCE(fingerprint, '') ILIKE $${index}
      OR COALESCE(category, '') ILIKE $${index}
      OR COALESCE(path, '') ILIKE $${index}
      OR COALESCE(method, '') ILIKE $${index}
      OR COALESCE(webhook_last_error, '') ILIKE $${index}
    )`);
        params.push(`%${search}%`);
        index += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await queryRead(`
    SELECT *, COUNT(*) OVER()::int AS total_count
    FROM error_incidents
    ${whereSql}
    ORDER BY
      CASE LOWER(current_state)
        WHEN 'actionable' THEN 0
        WHEN 'new' THEN 1
        WHEN 'fixed-monitoring' THEN 2
        WHEN 'suppressed' THEN 3
        WHEN 'closed' THEN 4
        ELSE 5
      END ASC,
      last_seen_at DESC,
      id DESC
    LIMIT $${index} OFFSET $${index + 1}
  `, [...params, limit, offset]);

    const total = rows[0]?.total_count ?? 0;
    return {
        total,
        rows: rows.map((row) => {
            const { total_count, ...rest } = row;
            return rest;
        }),
    };
};

export const setErrorIncidentState = async (id, state) => {
    const normalized = String(state ?? "").trim().toLowerCase();
    if (!INCIDENT_STATES.has(normalized)) {
        throw new Error(`Invalid incident state: ${state}`);
    }

    const monitorUntilAt = normalized === "fixed-monitoring"
        ? new Date(Date.now() + INCIDENT_MONITOR_MINUTES * 60000).toISOString()
        : null;
    const escalationState = normalized === "actionable" ? "pending-disabled" : "idle";

    const rows = await queryWrite(`
    UPDATE error_incidents
    SET
      current_state = $2,
      monitor_until_at = $3,
      escalation_state = $4,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [id, normalized, monitorUntilAt, escalationState]);

    return rows[0] ?? null;
};

export const getErrorIncidentsSummary = async (windowHours = 24) => {
    const safeWindowHours = Math.max(1, Math.min(720, Number(windowHours) || 24));
    const sinceIso = new Date(Date.now() - safeWindowHours * 60 * 60 * 1000).toISOString();

    const totalsRows = await queryRead(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE current_state = 'actionable')::int AS actionable,
      COUNT(*) FILTER (WHERE current_state = 'new')::int AS new_count,
      COUNT(*) FILTER (WHERE current_state = 'fixed-monitoring')::int AS monitoring,
      COUNT(*) FILTER (WHERE current_state = 'suppressed')::int AS suppressed,
      COUNT(*) FILTER (WHERE current_state = 'closed')::int AS closed,
      MAX(last_seen_at) AS last_seen_at
    FROM error_incidents
  `);

    const windowRows = await queryRead(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE current_state = 'actionable')::int AS actionable
    FROM error_incidents
    WHERE last_seen_at >= $1
  `, [sinceIso]);

    const stateRows = await queryRead(`
    SELECT current_state, COUNT(*)::int AS count
    FROM error_incidents
    WHERE last_seen_at >= $1
    GROUP BY current_state
  `, [sinceIso]);

    const byState = Object.fromEntries(
        stateRows.map((row) => [String(row.current_state ?? "unknown"), Number(row.count ?? 0)]),
    );

    const totals = totalsRows[0] ?? {
        total: 0,
        actionable: 0,
        new_count: 0,
        monitoring: 0,
        suppressed: 0,
        closed: 0,
        last_seen_at: null,
    };
    const window = windowRows[0] ?? { total: 0, actionable: 0 };

    return {
        windowHours: safeWindowHours,
        windowStartAt: sinceIso,
        total: Number(totals.total ?? 0),
        actionable: Number(totals.actionable ?? 0),
        newCount: Number(totals.new_count ?? 0),
        monitoring: Number(totals.monitoring ?? 0),
        suppressed: Number(totals.suppressed ?? 0),
        closed: Number(totals.closed ?? 0),
        windowTotal: Number(window.total ?? 0),
        windowActionable: Number(window.actionable ?? 0),
        lastSeenAt: totals.last_seen_at ?? null,
        byState,
    };
};

export const listErrorSuppressRules = async () => {
    return queryRead(`
    SELECT *
    FROM error_suppress_rules
    ORDER BY enabled DESC, id DESC
  `);
};

export const createErrorSuppressRule = async (rule) => {
    const rows = await queryWrite(`
    INSERT INTO error_suppress_rules (
      name, enabled, source, category, fingerprint,
      path_pattern, method, status_code, message_pattern, severity, notes,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      now()::text, now()::text
    )
    RETURNING *
  `, [
        rule.name,
        rule.enabled ?? 1,
        rule.source ?? null,
        rule.category ?? null,
        rule.fingerprint ?? null,
        rule.path_pattern ?? null,
        rule.method ?? null,
        rule.status_code ?? null,
        rule.message_pattern ?? null,
        rule.severity ?? null,
        rule.notes ?? null,
    ]);
    return rows[0] ?? null;
};

export const updateErrorSuppressRule = async (id, patch) => {
    const rows = await queryWrite(`
    UPDATE error_suppress_rules
    SET
      name = COALESCE($2, name),
      enabled = COALESCE($3, enabled),
      source = COALESCE($4, source),
      category = COALESCE($5, category),
      fingerprint = COALESCE($6, fingerprint),
      path_pattern = COALESCE($7, path_pattern),
      method = COALESCE($8, method),
      status_code = COALESCE($9, status_code),
      message_pattern = COALESCE($10, message_pattern),
      severity = COALESCE($11, severity),
      notes = COALESCE($12, notes),
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [
        id,
        patch.name ?? null,
        patch.enabled ?? null,
        patch.source ?? null,
        patch.category ?? null,
        patch.fingerprint ?? null,
        patch.path_pattern ?? null,
        patch.method ?? null,
        patch.status_code ?? null,
        patch.message_pattern ?? null,
        patch.severity ?? null,
        patch.notes ?? null,
    ]);

    return rows[0] ?? null;
};

export const deleteErrorSuppressRule = async (id) => {
    const rows = await queryWrite("DELETE FROM error_suppress_rules WHERE id = $1 RETURNING *", [id]);
    return rows[0] ?? null;
};

export const getErrorEventsSummary = async (windowHours = 24) => {
    const safeWindowHours = Math.max(1, Math.min(720, Number(windowHours) || 24));
    const sinceIso = new Date(Date.now() - safeWindowHours * 60 * 60 * 1000).toISOString();

    const totalsRows = await queryRead(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE acknowledged = 0)::int AS unacknowledged,
      COUNT(*) FILTER (WHERE actionable = 1 AND acknowledged = 0)::int AS actionable_unacknowledged,
      COUNT(*) FILTER (WHERE created_at >= $1)::int AS window_total,
      COUNT(*) FILTER (WHERE created_at >= $1 AND acknowledged = 0)::int AS window_unacknowledged,
      COUNT(*) FILTER (WHERE created_at >= $1 AND actionable = 1 AND acknowledged = 0)::int AS window_actionable_unacknowledged,
      MAX(created_at) AS last_event_at
    FROM error_events
  `, [sinceIso]);

    const severityRows = await queryRead(`
    SELECT severity, COUNT(*)::int AS count
    FROM error_events
    WHERE created_at >= $1
    GROUP BY severity
  `, [sinceIso]);

    const sourceRows = await queryRead(`
    SELECT source, COUNT(*)::int AS count
    FROM error_events
    WHERE created_at >= $1
    GROUP BY source
  `, [sinceIso]);

    const incidentStateRows = await queryRead(`
    SELECT incident_state, COUNT(*)::int AS count
    FROM error_events
    WHERE created_at >= $1
      AND acknowledged = 0
    GROUP BY incident_state
  `, [sinceIso]);

    const bySeverity = Object.fromEntries(
        severityRows.map((row) => [String(row.severity ?? "unknown"), Number(row.count ?? 0)]),
    );
    const bySource = Object.fromEntries(
        sourceRows.map((row) => [String(row.source ?? "unknown"), Number(row.count ?? 0)]),
    );
    const byIncidentState = Object.fromEntries(
        incidentStateRows.map((row) => [String(row.incident_state ?? "unknown"), Number(row.count ?? 0)]),
    );

    const totals = totalsRows[0] ?? {
        total: 0,
        unacknowledged: 0,
        actionable_unacknowledged: 0,
        window_total: 0,
        window_unacknowledged: 0,
        window_actionable_unacknowledged: 0,
        last_event_at: null,
    };

    return {
        windowHours: safeWindowHours,
        windowStartAt: sinceIso,
        total: Number(totals.total ?? 0),
        unacknowledged: Number(totals.unacknowledged ?? 0),
        actionableUnacknowledged: Number(totals.actionable_unacknowledged ?? 0),
        windowTotal: Number(totals.window_total ?? 0),
        windowUnacknowledged: Number(totals.window_unacknowledged ?? 0),
        windowActionableUnacknowledged: Number(totals.window_actionable_unacknowledged ?? 0),
        lastEventAt: totals.last_event_at ?? null,
        bySeverity,
        bySource,
        byIncidentState,
    };
};

export const countErrorEventsSince = async (sinceIso, minimumSeverity = "error") => {
    const minRank = toErrorSeverityRank(minimumSeverity);
    const rows = await queryRead(`
    SELECT COUNT(*)::int AS total
    FROM error_events
    WHERE created_at >= $1
      AND (
        CASE LOWER(severity)
          WHEN 'fatal' THEN 3
          WHEN 'error' THEN 2
          WHEN 'warn' THEN 1
          ELSE 0
        END
      ) >= $2
  `, [sinceIso, minRank]);
    return Number(rows[0]?.total ?? 0);
};

export const listErrorFingerprintsSince = async (sinceIso, minimumSeverity = "error", limit = 5) => {
    const minRank = toErrorSeverityRank(minimumSeverity);
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
    const rows = await queryRead(`
    SELECT
      COALESCE(NULLIF(TRIM(fingerprint), ''), '(none)') AS fingerprint,
      COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source,
      COALESCE(NULLIF(TRIM(category), ''), 'unknown') AS category,
      COUNT(*)::int AS count,
      MAX(created_at) AS last_seen_at,
      MAX(message) AS sample_message
    FROM error_events
    WHERE created_at >= $1
      AND (
        CASE LOWER(severity)
          WHEN 'fatal' THEN 3
          WHEN 'error' THEN 2
          WHEN 'warn' THEN 1
          ELSE 0
        END
      ) >= $2
    GROUP BY 1,2,3
    ORDER BY count DESC, last_seen_at DESC
    LIMIT $3
  `, [sinceIso, minRank, safeLimit]);

    return rows.map((row) => ({
        fingerprint: String(row.fingerprint ?? '(none)'),
        source: String(row.source ?? 'unknown'),
        category: String(row.category ?? 'unknown'),
        count: Number(row.count ?? 0),
        lastSeenAt: row.last_seen_at ?? null,
        sampleMessage: String(row.sample_message ?? ''),
    }));
};


export const insertJobRun = async (run) => {
    const rows = await queryWrite(`
    INSERT INTO job_runs (
      run_id, job_name, week_id, attempt, status,
      error_message, error_code, output, started_at, finished_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [
        run.run_id,
        run.job_name,
        run.week_id ?? null,
        run.attempt,
        run.status,
        run.error_message ?? null,
        run.error_code ?? null,
        run.output ?? null,
        run.started_at,
        run.finished_at ?? null,
    ]);
    return rows[0]?.id ?? null;
};
export const updateJobRun = async (id, patch) => {
    await queryWrite(`
    UPDATE job_runs
    SET
      status = COALESCE($2, status),
      error_message = COALESCE($3, error_message),
      error_code = COALESCE($4, error_code),
      output = COALESCE($5, output),
      finished_at = COALESCE($6, finished_at)
    WHERE id = $1
  `, [
        id,
        patch.status ?? null,
        patch.error_message ?? null,
        patch.error_code ?? null,
        patch.output ?? null,
        patch.finished_at ?? null,
    ]);
};
export const getLatestWeekId = async () => {
    const rows = await queryRead("SELECT id FROM weeks ORDER BY start_at DESC LIMIT 1");
    return rows[0]?.id ?? null;
};
export const listJobRunIncidents = async (limit = 50) => {
    return queryRead(`
    SELECT
      (ARRAY_AGG(run_id ORDER BY finished_at DESC NULLS LAST, started_at DESC NULLS LAST))[1] AS run_id,
      job_name,
      week_id,
      COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
      MIN(started_at) AS first_started_at,
      MAX(finished_at) AS last_finished_at,
      MAX(finished_at) FILTER (WHERE status = 'success') AS success_at,
      (ARRAY_AGG(attempt ORDER BY finished_at DESC NULLS LAST)
        FILTER (WHERE status = 'success'))[1]::int AS success_attempt,
      (ARRAY_AGG(error_message ORDER BY finished_at DESC NULLS LAST)
        FILTER (WHERE status = 'error'))[1] AS last_error,
      (ARRAY_AGG(error_code ORDER BY finished_at DESC NULLS LAST)
        FILTER (WHERE status = 'error'))[1] AS last_error_code,
      (ARRAY_AGG(status ORDER BY finished_at DESC NULLS LAST, started_at DESC NULLS LAST))[1] AS last_status
    FROM job_runs
    WHERE job_name IN ('run-week', 'refresh-week-coins', 'transition-lock', 'transition-start', 'finalize')
    GROUP BY job_name, week_id
    HAVING COUNT(*) FILTER (WHERE status = 'error') > 0
    ORDER BY last_finished_at DESC NULLS LAST
    LIMIT $1
  `, [limit]);
};
export const upsertSelfHealTask = async (task) => {
    const rows = await queryWrite(`
    INSERT INTO self_heal_tasks (
      task_type, task_key, week_id, payload_json, status,
      attempt_count, max_attempts, next_attempt_at, last_error, last_error_code,
      created_at, updated_at, resolved_at
    )
    VALUES ($1, $2, $3, $4, 'pending', 0, $5, now()::text, null, null, now()::text, now()::text, null)
    ON CONFLICT(task_type, task_key) DO UPDATE SET
      payload_json = EXCLUDED.payload_json,
      week_id = COALESCE(EXCLUDED.week_id, self_heal_tasks.week_id),
      max_attempts = GREATEST(self_heal_tasks.max_attempts, EXCLUDED.max_attempts),
      status = CASE
        WHEN self_heal_tasks.status = 'success' THEN 'success'
        ELSE 'pending'
      END,
      next_attempt_at = CASE
        WHEN self_heal_tasks.status = 'success' THEN self_heal_tasks.next_attempt_at
        ELSE now()::text
      END,
      last_error = CASE
        WHEN self_heal_tasks.status = 'success' THEN self_heal_tasks.last_error
        ELSE null
      END,
      last_error_code = CASE
        WHEN self_heal_tasks.status = 'success' THEN self_heal_tasks.last_error_code
        ELSE null
      END,
      resolved_at = CASE
        WHEN self_heal_tasks.status = 'success' THEN self_heal_tasks.resolved_at
        ELSE null
      END,
      updated_at = now()::text
    RETURNING *
  `, [
        task.task_type,
        task.task_key,
        task.week_id ?? null,
        task.payload_json,
        task.max_attempts ?? 12,
    ]);
    return rows[0];
};
export const getSelfHealTaskById = async (taskId) => {
    const rows = await queryRead("SELECT * FROM self_heal_tasks WHERE id = $1", [taskId]);
    return rows[0] ?? null;
};
export const claimSelfHealTask = async (taskId, nowIso) => {
    const rows = await queryWrite(`
    UPDATE self_heal_tasks
    SET
      status = 'running',
      attempt_count = attempt_count + 1,
      updated_at = now()::text,
      resolved_at = null
    WHERE id = $1
      AND status IN ('pending', 'retrying')
      AND next_attempt_at <= $2
    RETURNING *
  `, [taskId, nowIso]);
    return rows[0] ?? null;
};
export const listDueSelfHealTasks = async (limit, nowIso) => {
    return queryRead(`
    SELECT * FROM self_heal_tasks
    WHERE status IN ('pending', 'retrying')
      AND next_attempt_at <= $1
    ORDER BY next_attempt_at ASC, id ASC
    LIMIT $2
  `, [nowIso, limit]);
};
export const markSelfHealTaskSuccess = async (taskId) => {
    await queryWrite(`
    UPDATE self_heal_tasks
    SET
      status = 'success',
      last_error = null,
      last_error_code = null,
      resolved_at = now()::text,
      next_attempt_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
  `, [taskId]);
};
export const markSelfHealTaskRetry = async (taskId, nextAttemptAt, errorMessage, errorCode) => {
    await queryWrite(`
    UPDATE self_heal_tasks
    SET
      status = 'retrying',
      next_attempt_at = $2,
      last_error = $3,
      last_error_code = $4,
      resolved_at = null,
      updated_at = now()::text
    WHERE id = $1
  `, [taskId, nextAttemptAt, errorMessage, errorCode]);
};
export const markSelfHealTaskDead = async (taskId, errorMessage, errorCode) => {
    await queryWrite(`
    UPDATE self_heal_tasks
    SET
      status = 'dead',
      last_error = $2,
      last_error_code = $3,
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
  `, [taskId, errorMessage, errorCode]);
};
export const markSelfHealTaskCanceled = async (taskId) => {
    await queryWrite(`
    UPDATE self_heal_tasks
    SET
      status = 'canceled',
      last_error = 'Canceled by operator',
      last_error_code = 'stopped',
      resolved_at = now()::text,
      updated_at = now()::text
    WHERE id = $1
  `, [taskId]);
};
export const retrySelfHealTaskNow = async (taskId) => {
    const rows = await queryWrite(`
    UPDATE self_heal_tasks
    SET
      status = 'pending',
      next_attempt_at = now()::text,
      last_error = null,
      last_error_code = null,
      resolved_at = null,
      updated_at = now()::text
    WHERE id = $1
    RETURNING *
  `, [taskId]);
    return rows[0] ?? null;
};
export const insertSelfHealTaskRun = async (run) => {
    await queryWrite(`
    INSERT INTO self_heal_task_runs (
      task_id, attempt, status, error_message, error_code, started_at, finished_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
        run.task_id,
        run.attempt,
        run.status,
        run.error_message ?? null,
        run.error_code ?? null,
        run.started_at,
        run.finished_at,
    ]);
};
export const listSelfHealTasks = async (limit = 100) => {
    return queryRead(`
    SELECT
      t.*,
      r.attempt AS last_attempt,
      r.status AS last_run_status,
      r.error_message AS last_run_error_message,
      r.error_code AS last_run_error_code,
      r.finished_at AS last_run_finished_at
    FROM self_heal_tasks t
    LEFT JOIN LATERAL (
      SELECT attempt, status, error_message, error_code, finished_at
      FROM self_heal_task_runs
      WHERE task_id = t.id
      ORDER BY id DESC
      LIMIT 1
    ) r ON TRUE
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT $1
  `, [limit]);
};
export const listRecentSelfHealTaskRuns = async (limit = 100) => {
    return queryRead(`
    SELECT
      r.*,
      t.task_type,
      t.task_key,
      t.week_id
    FROM self_heal_task_runs r
    INNER JOIN self_heal_tasks t ON t.id = r.task_id
    ORDER BY r.id DESC
    LIMIT $1
  `, [limit]);
};
export const getSelfHealSummary = async () => {
    const rows = await queryRead(`
    SELECT status, COUNT(*)::int AS count
    FROM self_heal_tasks
    GROUP BY status
  `);
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const recoveredRows = await queryRead("SELECT COUNT(*)::int AS count FROM self_heal_tasks WHERE status = 'success' AND attempt_count > 1");
    return {
        total,
        byStatus,
        recovered: recoveredRows[0]?.count ?? 0,
    };
};







