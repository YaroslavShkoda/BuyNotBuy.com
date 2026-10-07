<!-- Сгенерировано. Правьте генератор: src/backend/research/docs-generate.ts
     и перегенерируйте: node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts -->

# База данных

Версий миграций: **21**, последняя — v21 «strategy_decision_log_natural_key».

Ниже — схема в том виде, в каком её строят текущие миграции, прочитанная
из каталога сервера, а не из текста SQL. Таблица ограничений `CHECK` в
`docs/invariants.md` когда-то цитировала SQL, который никто не
перезапускал, и поэтому четыре раунда требовала несуществующего
ограничения.

## Таблицы (18)

### `asset`

| столбец | тип | null |
|---|---|---|
| `symbol` | `text` | нет |
| `category` | `text` | нет |
| `status` | `text` | нет |
| `source` | `text` | нет |
| `decided_at` | `bigint` | нет |

Ограничения:

- `asset_category_known: CHECK ((category = ANY (ARRAY['crypto'::text, 'fiat'::text])))`
- `asset_source_known: CHECK ((source = ANY (ARRAY['configured'::text, 'learned'::text])))`
- `asset_status_known: CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'unknown'::text])))`
- `asset_symbol_shaped: CHECK ((symbol ~ '^[A-Z0-9]{2,12}$'::text))`

### `holdout_verdict`

| столбец | тип | null |
|---|---|---|
| `id` | `integer` | нет |
| `created_at` | `bigint` | нет |
| `protocol_fingerprint` | `text` | нет |
| `protocol_metrics` | `text` | нет |
| `protocol_note` | `text` | нет |
| `readings` | `jsonb` | нет |
| `candidates` | `jsonb` | нет |
| `first_bar_at` | `bigint` | нет |
| `last_bar_at` | `bigint` | нет |
| `bar_count` | `integer` | нет |

Ограничения:

- `holdout_verdict_candidates_shape: CHECK ((jsonb_typeof(candidates) = 'array'::text))`
- `holdout_verdict_has_bars: CHECK ((bar_count > 0))`
- `holdout_verdict_readings_shape: CHECK ((jsonb_typeof(readings) = 'array'::text))`
- `holdout_verdict_singleton: CHECK ((id = 1))`

### `index_audit`

| столбец | тип | null |
|---|---|---|
| `table_name` | `text` | нет |
| `index_name` | `text` | нет |
| `purpose` | `text` | нет |
| `required_by` | `text` | нет |
| `created_at` | `bigint` | нет |

### `indicator_vote`

| столбец | тип | null |
|---|---|---|
| `symbol` | `text` | нет |
| `vote_bucket` | `bigint` | нет |
| `timestamp` | `bigint` | нет |
| `indicator` | `text` | нет |
| `signal` | `text` | нет |
| `weight` | `integer` | нет |
| `price` | `double precision` | нет |
| `fwd_return_1h` | `double precision` | да |
| `fwd_return_4h` | `double precision` | да |
| `fwd_return_24h` | `double precision` | да |

Ограничения:

- `indicator_vote_signal_check: CHECK ((signal = ANY (ARRAY['LONG'::text, 'SHORT'::text, 'NEUTRAL'::text])))`
- `indicator_vote_weight_check: CHECK (((weight >= 0) AND (weight <= 100)))`

### `instrument`

| столбец | тип | null |
|---|---|---|
| `ticker` | `text` | нет |
| `base_asset` | `text` | нет |
| `quote_asset` | `text` | нет |
| `market_kind` | `text` | нет |
| `status` | `text` | нет |

Ограничения:

- `instrument_halves_differ: CHECK ((base_asset <> quote_asset))`
- `instrument_market_kind_known: CHECK ((market_kind = ANY (ARRAY['crypto'::text, 'fiat'::text, 'mixed'::text, 'unknown'::text])))`
- `instrument_status_known: CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))`
- `instrument_ticker_is_its_halves: CHECK ((ticker = (base_asset || quote_asset)))`
- `instrument_ticker_shaped: CHECK ((ticker ~ '^[A-Z0-9]{3,32}$'::text))`
- `instrument_ticker_starts_with_base: CHECK (("left"(ticker, length(base_asset)) = base_asset))`

### `market_candles`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `provider` | `text` | нет |
| `symbol` | `text` | нет |
| `interval` | `text` | нет |
| `timestamp` | `bigint` | нет |
| `open` | `double precision` | нет |
| `high` | `double precision` | нет |
| `low` | `double precision` | нет |
| `close` | `double precision` | нет |
| `volume` | `double precision` | нет |
| `ingested_at` | `bigint` | нет |
| `is_closed` | `boolean` | нет |

Ограничения:

- `market_candles_ohlc_sane: CHECK (((high >= low) AND (high >= open) AND (high >= close) AND (low <= open) AND (low <= close) AND (open > (0)::double precision) AND (high > (0)::double precision) AND (low > (0)::double precision) AND (close > (0)::double precision) AND (volume >= (0)::double precision)))`

### `rate_limit_window`

| столбец | тип | null |
|---|---|---|
| `bucket` | `text` | нет |
| `window_start` | `bigint` | нет |
| `count` | `integer` | нет |

### `retention_policy`

| столбец | тип | null |
|---|---|---|
| `table_name` | `text` | нет |
| `keep_days` | `integer` | нет |
| `rationale` | `text` | нет |
| `updated_at` | `bigint` | нет |

Ограничения:

- `retention_policy_keep_days_check: CHECK ((keep_days > 0))`

### `retention_run`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `table_name` | `text` | нет |
| `started_at` | `bigint` | нет |
| `finished_at` | `bigint` | нет |
| `cutoff` | `bigint` | нет |
| `deleted_rows` | `bigint` | нет |
| `duration_ms` | `bigint` | нет |
| `skipped` | `bigint` | нет |

### `schema_migrations`

| столбец | тип | null |
|---|---|---|
| `version` | `integer` | нет |
| `name` | `text` | нет |
| `applied_at` | `bigint` | нет |

### `signal_history`

| столбец | тип | null |
|---|---|---|
| `symbol` | `text` | нет |
| `hour_bucket` | `bigint` | нет |
| `timestamp` | `bigint` | нет |
| `signal` | `text` | нет |
| `consensus` | `integer` | нет |
| `price` | `double precision` | нет |
| `provider` | `text` | нет |
| `interval` | `text` | нет |
| `regime` | `text` | да |
| `data_quality` | `double precision` | да |
| `data_quality_usable` | `boolean` | да |
| `data_quality_worst` | `text` | да |
| `signal_state_id` | `bigint` | да |

Ограничения:

- `signal_history_consensus_check: CHECK (((consensus >= 0) AND (consensus <= 100)))`
- `signal_history_signal_check: CHECK ((signal = ANY (ARRAY['LONG'::text, 'SHORT'::text, 'NEUTRAL'::text])))`

### `signal_outcome`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `symbol` | `text` | нет |
| `provider` | `text` | нет |
| `interval` | `text` | нет |
| `signal_state_id` | `bigint` | да |
| `direction` | `text` | нет |
| `verdict` | `text` | нет |
| `horizon_bars` | `integer` | нет |
| `entry_timestamp` | `bigint` | нет |
| `entry_price` | `double precision` | нет |
| `exit_timestamp` | `bigint` | да |
| `exit_price` | `double precision` | да |
| `return_fraction` | `double precision` | да |
| `max_favourable` | `double precision` | да |
| `max_adverse` | `double precision` | да |
| `closed_by` | `text` | да |
| `regime` | `text` | да |
| `data_quality` | `double precision` | да |
| `strategy_version_id` | `bigint` | да |
| `created_at` | `bigint` | нет |
| `updated_at` | `bigint` | нет |

Ограничения:

- `signal_outcome_closed_by_check: CHECK (((closed_by IS NULL) OR (closed_by = ANY (ARRAY['invalidated'::text, 'expired'::text, 'reversed'::text]))))`
- `signal_outcome_direction_check: CHECK ((direction = ANY (ARRAY['LONG'::text, 'SHORT'::text])))`
- `signal_outcome_entry_price_check: CHECK ((entry_price > (0)::double precision))`
- `signal_outcome_horizon_bars_check: CHECK ((horizon_bars > 0))`
- `signal_outcome_verdict_check: CHECK ((verdict = ANY (ARRAY['correct'::text, 'incorrect'::text, 'flat'::text, 'unknown'::text, 'expired'::text])))`

### `signal_snapshot`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `created_at` | `bigint` | нет |
| `symbol` | `text` | нет |
| `strategy_version_id` | `bigint` | нет |
| `input_hash` | `text` | нет |
| `snapshot` | `jsonb` | нет |
| `first_candle_ts` | `bigint` | нет |
| `last_candle_ts` | `bigint` | нет |
| `candle_count` | `integer` | нет |
| `candles_hash` | `text` | нет |
| `provider` | `text` | да |
| `interval` | `text` | да |

### `signal_state`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `symbol` | `text` | нет |
| `provider` | `text` | нет |
| `interval` | `text` | нет |
| `direction` | `text` | нет |
| `status` | `text` | нет |
| `snapshot_id` | `bigint` | да |
| `price` | `double precision` | нет |
| `confidence` | `double precision` | нет |
| `published_at` | `bigint` | нет |
| `candle_timestamp` | `bigint` | нет |
| `created_at` | `bigint` | нет |
| `updated_at` | `bigint` | нет |

Ограничения:

- `signal_state_confidence_bounded: CHECK (((confidence >= (0)::double precision) AND (confidence <= (100)::double precision)))`
- `signal_state_direction_known: CHECK ((direction = ANY (ARRAY['LONG'::text, 'SHORT'::text])))`
- `signal_state_price_positive: CHECK ((price > (0)::double precision))`
- `signal_state_status_known: CHECK ((status = ANY (ARRAY['GENERATED'::text, 'ACTIVE'::text, 'UPDATED'::text, 'INVALIDATED'::text, 'EXPIRED'::text, 'CLOSED'::text])))`

### `signal_strategy_version`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `rule_id` | `text` | нет |
| `stage` | `text` | нет |
| `parameters` | `jsonb` | нет |
| `promoted_at` | `bigint` | нет |
| `retired_at` | `bigint` | да |
| `created_at` | `bigint` | нет |
| `strategy_version_id` | `bigint` | да |

Ограничения:

- `signal_strategy_version_check: CHECK (((retired_at IS NULL) OR (retired_at >= promoted_at)))`
- `signal_strategy_version_stage_check: CHECK ((stage = ANY (ARRAY['candidate'::text, 'backtest'::text, 'walk-forward'::text, 'shadow'::text, 'approval'::text, 'production'::text, 'retired'::text])))`

### `signal_transition`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `state_id` | `bigint` | нет |
| `symbol` | `text` | нет |
| `provider` | `text` | нет |
| `interval` | `text` | нет |
| `from_status` | `text` | да |
| `to_status` | `text` | нет |
| `from_direction` | `text` | да |
| `to_direction` | `text` | нет |
| `reason` | `text` | нет |
| `candle_timestamp` | `bigint` | нет |
| `price` | `double precision` | нет |
| `created_at` | `bigint` | нет |

Ограничения:

- `signal_transition_price_positive: CHECK ((price > (0)::double precision))`
- `signal_transition_to_known: CHECK ((to_status = ANY (ARRAY['GENERATED'::text, 'ACTIVE'::text, 'UPDATED'::text, 'INVALIDATED'::text, 'EXPIRED'::text, 'CLOSED'::text])))`

### `strategy_decision_log`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `created_at` | `bigint` | нет |
| `symbol` | `text` | нет |
| `strategy_version_id` | `bigint` | да |
| `primary_rule` | `text` | нет |
| `primary_direction` | `text` | нет |
| `primary_confidence` | `integer` | нет |
| `fallback_rule` | `text` | да |
| `fallback_direction` | `text` | да |
| `fallback_confidence` | `integer` | да |
| `published_rule` | `text` | нет |
| `published_direction` | `text` | нет |
| `suppressed` | `boolean` | нет |

Ограничения:

- `strategy_decision_log_direction: CHECK ((primary_direction = ANY (ARRAY['LONG'::text, 'SHORT'::text, 'NEUTRAL'::text])))`
- `strategy_decision_log_fallback_direction: CHECK (((fallback_direction IS NULL) OR (fallback_direction = ANY (ARRAY['LONG'::text, 'SHORT'::text, 'NEUTRAL'::text]))))`
- `strategy_decision_log_published_direction: CHECK ((published_direction = ANY (ARRAY['LONG'::text, 'SHORT'::text, 'NEUTRAL'::text])))`
- `strategy_decision_log_suppression_means_voice: CHECK (((NOT suppressed) OR (fallback_direction IS NOT NULL)))`

### `strategy_version`

| столбец | тип | null |
|---|---|---|
| `id` | `bigint` | нет |
| `created_at` | `bigint` | нет |
| `name` | `text` | нет |
| `description` | `text` | нет |
| `config` | `jsonb` | нет |
| `config_hash` | `text` | нет |

## Индексы (42)

| индекс | таблица |
|---|---|
| `asset_pkey` | `asset` |
| `holdout_verdict_pkey` | `holdout_verdict` |
| `index_audit_pkey` | `index_audit` |
| `idx_indicator_vote_unsettled` | `indicator_vote` |
| `indicator_vote_pkey` | `indicator_vote` |
| `instrument_base_idx` | `instrument` |
| `instrument_pkey` | `instrument` |
| `instrument_quote_idx` | `instrument` |
| `idx_market_candles_recent` | `market_candles` |
| `market_candles_pkey` | `market_candles` |
| `market_candles_provider_symbol_interval_timestamp_key` | `market_candles` |
| `rate_limit_window_pkey` | `rate_limit_window` |
| `retention_policy_pkey` | `retention_policy` |
| `idx_retention_run_table` | `retention_run` |
| `retention_run_pkey` | `retention_run` |
| `schema_migrations_pkey` | `schema_migrations` |
| `idx_signal_history_regime` | `signal_history` |
| `idx_signal_history_series_time` | `signal_history` |
| `signal_history_pkey` | `signal_history` |
| `idx_signal_outcome_regime` | `signal_outcome` |
| `idx_signal_outcome_series` | `signal_outcome` |
| `idx_signal_outcome_unresolved` | `signal_outcome` |
| `signal_outcome_pkey` | `signal_outcome` |
| `signal_outcome_symbol_provider_interval_signal_state_id_hor_key` | `signal_outcome` |
| `idx_signal_snapshot_created` | `signal_snapshot` |
| `signal_snapshot_pkey` | `signal_snapshot` |
| `signal_snapshot_symbol_input_hash_key` | `signal_snapshot` |
| `idx_signal_state_status` | `signal_state` |
| `signal_state_pkey` | `signal_state` |
| `signal_state_symbol_provider_interval_key` | `signal_state` |
| `idx_signal_strategy_version_config` | `signal_strategy_version` |
| `idx_signal_strategy_version_live` | `signal_strategy_version` |
| `signal_strategy_version_pkey` | `signal_strategy_version` |
| `idx_signal_transition_series` | `signal_transition` |
| `idx_signal_transition_state` | `signal_transition` |
| `signal_transition_pkey` | `signal_transition` |
| `idx_strategy_decision_log_rule` | `strategy_decision_log` |
| `idx_strategy_decision_log_time` | `strategy_decision_log` |
| `strategy_decision_log_pkey` | `strategy_decision_log` |
| `ux_strategy_decision_log_symbol_cycle` | `strategy_decision_log` |
| `strategy_version_config_hash_key` | `strategy_version` |
| `strategy_version_pkey` | `strategy_version` |

## Политика хранения

Политика живёт в таблице `retention_policy`, а не в конфиге: её читает
задание, и её должно быть видно в базе, а не только в исходниках. Границы
по каждой таблице проверяются `db/retention.store.ts`.
