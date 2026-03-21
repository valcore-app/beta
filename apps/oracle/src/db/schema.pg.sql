-- Valcore Oracle Database Schema (Postgres)

-- Weeks table
CREATE TABLE IF NOT EXISTS weeks (
  id TEXT PRIMARY KEY,
  start_at TEXT NOT NULL,
  lock_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT_OPEN',
  created_at TEXT NOT NULL DEFAULT (now()::text),
  finalized_at TEXT
);

ALTER TABLE weeks ADD COLUMN IF NOT EXISTS finalized_at TEXT;

-- Coin Categories (lookup table for coin types)
CREATE TABLE IF NOT EXISTS coin_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);

INSERT INTO coin_categories (id, name, description, sort_order)
VALUES
  ('stablecoin', 'Stablecoin', 'Stable assets used for GK picks', 1),
  ('eligible', 'Eligible', 'Tradable assets eligible for DEF/MID/FWD', 2),
  ('excluded', 'Excluded', 'Filtered assets not used in lineup generation', 3)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Coins table (immutable data only, rank is in week_coins)
CREATE TABLE IF NOT EXISTS coins (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL DEFAULT 'excluded',
  image_path TEXT,
  last_updated TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (category_id) REFERENCES coin_categories(id)
);

CREATE INDEX IF NOT EXISTS idx_coins_symbol ON coins(symbol);
CREATE INDEX IF NOT EXISTS idx_coins_category ON coins(category_id);
CREATE INDEX IF NOT EXISTS idx_coins_created_at ON coins(created_at);

-- Week Coins (coin assignments per week)
CREATE TABLE IF NOT EXISTS week_coins (
  week_id TEXT NOT NULL,
  coin_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  position TEXT NOT NULL,
  salary DOUBLE PRECISION NOT NULL,
  power INTEGER NOT NULL DEFAULT 0,
  risk TEXT NOT NULL DEFAULT 'Medium',
  momentum TEXT NOT NULL DEFAULT 'Steady',
  momentum_live TEXT,
  metrics_updated_at TEXT,
  momentum_live_updated_at TEXT,
  PRIMARY KEY (week_id, coin_id),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE,
  FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_week_coins_week ON week_coins(week_id);
CREATE INDEX IF NOT EXISTS idx_week_coins_position ON week_coins(position);

ALTER TABLE week_coins DROP COLUMN IF EXISTS snapshot_price;

-- Lineups (user submissions)
CREATE TABLE IF NOT EXISTS lineups (
  week_id TEXT NOT NULL,
  address TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  lineup_hash TEXT NOT NULL,
  deposit_wei TEXT NOT NULL,
  principal_wei TEXT NOT NULL,
  risk_wei TEXT NOT NULL,
  swaps INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (week_id, address),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lineups_address ON lineups(address);
CREATE INDEX IF NOT EXISTS idx_lineups_week ON lineups(week_id);

-- Strategies (persistent identity for protocol participants)
CREATE SEQUENCE IF NOT EXISTS strategy_public_seq START WITH 1000;

CREATE TABLE IF NOT EXISTS strategies (
  id BIGSERIAL PRIMARY KEY,
  strategy_id TEXT NOT NULL UNIQUE DEFAULT ('STR-' || LPAD(nextval('strategy_public_seq')::text, 7, '0')),
  owner_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_strategies_owner ON strategies(owner_address);
CREATE INDEX IF NOT EXISTS idx_strategies_created ON strategies(created_at);

-- Strategy Epoch Entries (weekly snapshots for each strategy)
CREATE TABLE IF NOT EXISTS strategy_epoch_entries (
  id BIGSERIAL PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  lineup_hash TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  deposit_wei TEXT NOT NULL,
  principal_wei TEXT NOT NULL,
  risk_wei TEXT NOT NULL,
  swaps INTEGER NOT NULL DEFAULT 0,
  score DOUBLE PRECISION,
  rank INTEGER,
  reward_wei TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(epoch_id, strategy_id),
  FOREIGN KEY (strategy_id) REFERENCES strategies(strategy_id) ON DELETE CASCADE
);

ALTER TABLE strategy_epoch_entries ADD COLUMN IF NOT EXISTS season_id TEXT;
ALTER TABLE strategy_epoch_entries ADD COLUMN IF NOT EXISTS season_points INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_strategy_epoch_entries_epoch ON strategy_epoch_entries(epoch_id);
CREATE INDEX IF NOT EXISTS idx_strategy_epoch_entries_strategy ON strategy_epoch_entries(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_epoch_entries_score ON strategy_epoch_entries(epoch_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_epoch_entries_season ON strategy_epoch_entries(season_id);
CREATE INDEX IF NOT EXISTS idx_strategy_epoch_entries_season_points ON strategy_epoch_entries(season_id, season_points DESC);

-- Strategy Season Entries (season-level league standings)
CREATE TABLE IF NOT EXISTS strategy_season_entries (
  id BIGSERIAL PRIMARY KEY,
  season_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  season_points INTEGER NOT NULL DEFAULT 0,
  epochs_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  top10 INTEGER NOT NULL DEFAULT 0,
  avg_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  best_rank INTEGER,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(season_id, strategy_id),
  FOREIGN KEY (strategy_id) REFERENCES strategies(strategy_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_strategy_season_entries_season ON strategy_season_entries(season_id);
CREATE INDEX IF NOT EXISTS idx_strategy_season_entries_strategy ON strategy_season_entries(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_season_entries_points ON strategy_season_entries(season_id, season_points DESC);

-- Lineup Tx Intents (DB->chain->DB orchestration for user commit/swap flows)
CREATE TABLE IF NOT EXISTS lineup_tx_intents (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL,
  address TEXT NOT NULL,
  source TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  swap_json TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  tx_hash TEXT UNIQUE,
  self_heal_task_id BIGINT,
  synced INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  resolved_at TEXT,
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lineup_tx_intents_week ON lineup_tx_intents(week_id);

CREATE INDEX IF NOT EXISTS idx_lineup_tx_intents_status ON lineup_tx_intents(status);

-- Lifecycle Tx Intents (DB->chain->DB orchestration for week/finalize state transitions)
CREATE TABLE IF NOT EXISTS lifecycle_tx_intents (
  id BIGSERIAL PRIMARY KEY,
  op_key TEXT NOT NULL UNIQUE,
  week_id TEXT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  tx_hash TEXT,
  details_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  resolved_at TEXT,
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_tx_intents_week ON lifecycle_tx_intents(week_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_tx_intents_status ON lifecycle_tx_intents(status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_tx_intents_operation ON lifecycle_tx_intents(operation);
-- Weekly Coin Prices (global start/end prices for each coin per week)
CREATE TABLE IF NOT EXISTS weekly_coin_prices (
  id BIGSERIAL PRIMARY KEY,
  week_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  start_price DOUBLE PRECISION,
  end_price DOUBLE PRECISION,
  start_timestamp BIGINT,
  end_timestamp BIGINT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(week_id, symbol),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weekly_coin_prices_week ON weekly_coin_prices(week_id);
CREATE INDEX IF NOT EXISTS idx_weekly_coin_prices_symbol ON weekly_coin_prices(symbol);

-- Week Showcase Lineups (spectator board cache for active week)
CREATE TABLE IF NOT EXISTS week_showcase_lineups (
  week_id TEXT PRIMARY KEY,
  formation_id TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_week_showcase_lineups_generated ON week_showcase_lineups(generated_at);

-- Lineup Positions (user-specific position tracking for swaps)
CREATE TABLE IF NOT EXISTS lineup_positions (
  id BIGSERIAL PRIMARY KEY,
  week_id TEXT NOT NULL,
  lineup_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  salary_used DOUBLE PRECISION NOT NULL,
  start_price DOUBLE PRECISION NOT NULL,
  start_timestamp BIGINT NOT NULL,
  end_price DOUBLE PRECISION,
  end_timestamp BIGINT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lineup_positions_week ON lineup_positions(week_id);
CREATE INDEX IF NOT EXISTS idx_lineup_positions_lineup ON lineup_positions(lineup_id);
CREATE INDEX IF NOT EXISTS idx_lineup_positions_active ON lineup_positions(is_active);

-- Weekly Results (scoring results per lineup)
CREATE TABLE IF NOT EXISTS weekly_results (
  id BIGSERIAL PRIMARY KEY,
  week_id TEXT NOT NULL,
  lineup_id TEXT NOT NULL,
  address TEXT NOT NULL,
  raw_performance DOUBLE PRECISION NOT NULL,
  efficiency_multiplier DOUBLE PRECISION NOT NULL,
  final_score DOUBLE PRECISION NOT NULL,
  reward_amount_wei TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(week_id, lineup_id),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weekly_results_week ON weekly_results(week_id);
CREATE INDEX IF NOT EXISTS idx_weekly_results_score ON weekly_results(final_score DESC);

-- Swap Log (for idempotency tracking)
CREATE TABLE IF NOT EXISTS swap_log (
  id BIGSERIAL PRIMARY KEY,
  week_id TEXT NOT NULL,
  lineup_id TEXT NOT NULL,
  swap_tx_hash TEXT NOT NULL UNIQUE,
  removed_symbol TEXT NOT NULL,
  added_symbol TEXT NOT NULL,
  swap_timestamp BIGINT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_swap_log_tx ON swap_log(swap_tx_hash);
CREATE INDEX IF NOT EXISTS idx_swap_log_lineup ON swap_log(lineup_id);

-- Faucet Claims (rate limiting for testnet stablecoin faucet)
CREATE TABLE IF NOT EXISTS faucet_claims (
  address TEXT PRIMARY KEY,
  last_claim_at TEXT NOT NULL,
  last_tx_hash TEXT
);

-- Strategist Profiles (wallet -> display name)
CREATE TABLE IF NOT EXISTS strategist_profiles (
  address TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategist_profiles_display_name_ci
  ON strategist_profiles(LOWER(display_name));


-- Error Events (centralized client/server error telemetry)
CREATE TABLE IF NOT EXISTS error_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT,
  source TEXT NOT NULL DEFAULT 'web-client',
  severity TEXT NOT NULL DEFAULT 'error',
  category TEXT NOT NULL DEFAULT 'runtime',
  message TEXT NOT NULL,
  error_name TEXT,
  stack TEXT,
  fingerprint TEXT,
  path TEXT,
  method TEXT,
  status_code INTEGER,
  context_json TEXT,
  tags_json TEXT,
  release TEXT,
  session_address TEXT,
  wallet_address TEXT,
  strategist_display_name TEXT,
  user_agent TEXT,
  ip_address TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_error_events_event_id
  ON error_events(event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_error_events_created_at
  ON error_events(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_error_events_ack
  ON error_events(acknowledged, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_events_severity
  ON error_events(severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_events_source
  ON error_events(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_events_fingerprint
  ON error_events(fingerprint);

ALTER TABLE error_events ADD COLUMN IF NOT EXISTS incident_key TEXT;
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS incident_state TEXT NOT NULL DEFAULT 'new';
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS actionable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS suppressed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS suppression_reason TEXT;
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS regression INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS escalation_state TEXT NOT NULL DEFAULT 'idle';

CREATE INDEX IF NOT EXISTS idx_error_events_incident_key
  ON error_events(incident_key);

CREATE INDEX IF NOT EXISTS idx_error_events_incident_state
  ON error_events(incident_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_events_actionable
  ON error_events(actionable, acknowledged, created_at DESC);

-- Error Suppression Rules (noise control)
CREATE TABLE IF NOT EXISTS error_suppress_rules (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  category TEXT,
  fingerprint TEXT,
  path_pattern TEXT,
  method TEXT,
  status_code INTEGER,
  message_pattern TEXT,
  severity TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_error_suppress_rules_enabled
  ON error_suppress_rules(enabled, id DESC);

CREATE INDEX IF NOT EXISTS idx_error_suppress_rules_source
  ON error_suppress_rules(source);

-- Error Incidents (action center aggregate)
CREATE TABLE IF NOT EXISTS error_incidents (
  id BIGSERIAL PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  fingerprint TEXT,
  category TEXT,
  path TEXT,
  method TEXT,
  status_code INTEGER,
  current_state TEXT NOT NULL DEFAULT 'new',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  unacked_count INTEGER NOT NULL DEFAULT 1,
  last_error_event_id BIGINT,
  suppression_rule_id BIGINT,
  monitor_until_at TEXT,
  regression_count INTEGER NOT NULL DEFAULT 0,
  escalation_state TEXT NOT NULL DEFAULT 'pending-disabled',
  webhook_last_attempt_at TEXT,
  webhook_last_error TEXT,
  webhook_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_error_incidents_state
  ON error_incidents(current_state, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_incidents_unacked
  ON error_incidents(unacked_count DESC, last_seen_at DESC);
-- Job Runs (ops job execution logs)
CREATE TABLE IF NOT EXISTS job_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  week_id TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  error_code TEXT,
  output TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_job_runs_week ON job_runs(week_id);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_name);
CREATE INDEX IF NOT EXISTS idx_job_runs_run ON job_runs(run_id);

-- Mock Lineups (ops simulation only, does not affect on-chain commits)
CREATE TABLE IF NOT EXISTS mock_lineups (
  id BIGSERIAL PRIMARY KEY,
  week_id TEXT NOT NULL,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  formation_id TEXT NOT NULL,
  total_salary DOUBLE PRECISION NOT NULL,
  lineup_hash TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(week_id, label),
  UNIQUE(week_id, address),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mock_lineups_week ON mock_lineups(week_id);
CREATE INDEX IF NOT EXISTS idx_mock_lineups_address ON mock_lineups(address);

DROP TABLE IF EXISTS mock_lineup_score_snapshots;

-- Mock score aggregates (single row per capture interval)
CREATE TABLE IF NOT EXISTS mock_score_aggregates (
  id BIGSERIAL PRIMARY KEY,
  week_id TEXT NOT NULL,
  model_key TEXT NOT NULL DEFAULT 'model_a',
  sample_count INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  neutral INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (week_id) REFERENCES weeks(id) ON DELETE CASCADE
);

ALTER TABLE mock_score_aggregates
  ADD COLUMN IF NOT EXISTS model_key TEXT NOT NULL DEFAULT 'model_a';

CREATE INDEX IF NOT EXISTS idx_mock_score_aggregates_week_model_capture ON mock_score_aggregates(week_id, model_key, captured_at);

-- Self-heal tasks (durable retries for post-chain DB sync and similar repairs)
CREATE TABLE IF NOT EXISTS self_heal_tasks (
  id BIGSERIAL PRIMARY KEY,
  task_type TEXT NOT NULL,
  task_key TEXT NOT NULL,
  week_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 12,
  next_attempt_at TEXT NOT NULL DEFAULT (now()::text),
  last_error TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  resolved_at TEXT,
  UNIQUE(task_type, task_key)
);

CREATE INDEX IF NOT EXISTS idx_self_heal_tasks_status ON self_heal_tasks(status);
CREATE INDEX IF NOT EXISTS idx_self_heal_tasks_next_attempt ON self_heal_tasks(next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_self_heal_tasks_week ON self_heal_tasks(week_id);

CREATE TABLE IF NOT EXISTS self_heal_task_runs (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (task_id) REFERENCES self_heal_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_self_heal_task_runs_task ON self_heal_task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_self_heal_task_runs_created ON self_heal_task_runs(created_at);


