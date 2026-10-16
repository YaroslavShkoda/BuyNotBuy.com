import type { Migration } from './types.js';

export const migration025_series_interval_in_votes_and_decisions: Migration = {
    version: 25,
    name: 'series_interval_in_votes_and_decisions',
    sql: `
        -- Two tables were the last ones whose rows did not name the candle
        -- interval they were computed from. Every other market table
        -- (market_candles, signal_history, signal_state, signal_transition,
        -- signal_outcome, signal_snapshot) already carries the interval as part
        -- of a row's identity, so two intervals of one symbol have always been
        -- two series there. indicator_vote and strategy_decision_log keyed by
        -- time alone, which made them correct only while the system computed a
        -- single interval -- and wrong the moment a second one existed: a 15m
        -- vote would have collided with the 1h vote of the same hour, and a
        -- 1d decision would have swallowed the 1h decision of the same
        -- millisecond through ON CONFLICT DO NOTHING.
        --
        -- Backfill. Both tables are populated '1h'. The system has only ever
        -- computed one interval per deployment -- the configured default --
        -- and every interval-carrying row in the audited databases reads '1h'
        -- (signal_history, market_candles, signal_state, signal_snapshot,
        -- signal_transition all contain exactly one distinct value). No row is
        -- duplicated across intervals, because there is no evidence any row
        -- belongs to a second one. PRECONDITION for applying this migration to
        -- any other environment: that deployment must never have run a
        -- non-default MARKET_CANDLE_INTERVAL. If one has, correct the backfill
        -- below before applying.
        --
        -- The column keeps its DEFAULT. It exists for the window in which the
        -- database is already migrated but the previous build is still
        -- writing: a writer that has never heard of the column can only have
        -- been computing the one interval, so defaulting it is a fact rather
        -- than a guess. The application layer passes the interval explicitly
        -- on every write; nothing relies on the default.
        ALTER TABLE indicator_vote
            ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT '1h';
        ALTER TABLE strategy_decision_log
            ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT '1h';

        -- The primary key of a vote is rebuilt with the interval in it.
        -- Without this, the first row a second interval wrote would violate
        -- the old key before any unique index was even consulted.
        ALTER TABLE indicator_vote DROP CONSTRAINT indicator_vote_pkey;
        ALTER TABLE indicator_vote
            ADD PRIMARY KEY (symbol, interval, vote_bucket, indicator);

        -- The instrument-scoped keys are rebuilt to match, because they are
        -- what the repository's ON CONFLICT targets read: a vote upsert and a
        -- decision replay must stay idempotent within one interval and stay
        -- independent across intervals.
        DROP INDEX IF EXISTS indicator_vote_instrument_bucket_unique;
        CREATE UNIQUE INDEX IF NOT EXISTS indicator_vote_instrument_interval_bucket_unique
            ON indicator_vote (instrument_id, interval, vote_bucket, indicator);

        DROP INDEX IF EXISTS ux_strategy_decision_log_symbol_cycle;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_strategy_decision_log_symbol_interval_cycle
            ON strategy_decision_log (symbol, interval, created_at);

        DROP INDEX IF EXISTS strategy_decision_instrument_time_unique;
        CREATE UNIQUE INDEX IF NOT EXISTS strategy_decision_instrument_interval_time_unique
            ON strategy_decision_log (instrument_id, interval, created_at);

        -- Down (forward-only ledger; recorded here, not automated):
        --
        -- Preconditions, checked in order before starting:
        --   * All writers (app and CLI) are stopped for the duration.
        --   * A fresh, restore-verified backup exists.
        --   * schema_migrations holds exactly 25 rows with max(version) = 25.
        --     If any version above 25 is present, or the ledger or schema is
        --     inconsistent, stop and switch to a dedicated recovery plan:
        --     never delete version 25 while later migrations exist.
        --   * Both target tables contain only interval = '1h' rows, verified
        --     before the column is dropped; afterwards the distinction is
        --     lost.
        --
        -- Non-1h rows must not be deleted or rewritten automatically: export
        -- them to a backup table and require an explicit data-owner decision
        -- first.
        --
        --   DROP INDEX indicator_vote_instrument_interval_bucket_unique;
        --   CREATE UNIQUE INDEX indicator_vote_instrument_bucket_unique
        --       ON indicator_vote (instrument_id, vote_bucket, indicator);
        --   DROP INDEX ux_strategy_decision_log_symbol_interval_cycle;
        --   CREATE UNIQUE INDEX ux_strategy_decision_log_symbol_cycle
        --       ON strategy_decision_log (symbol, created_at);
        --   DROP INDEX strategy_decision_instrument_interval_time_unique;
        --   CREATE UNIQUE INDEX strategy_decision_instrument_time_unique
        --       ON strategy_decision_log (instrument_id, created_at);
        --   ALTER TABLE indicator_vote DROP CONSTRAINT indicator_vote_pkey;
        --   ALTER TABLE indicator_vote
        --       ADD PRIMARY KEY (symbol, vote_bucket, indicator);
        --   ALTER TABLE indicator_vote DROP COLUMN interval;
        --   ALTER TABLE strategy_decision_log DROP COLUMN interval;
        --   DELETE FROM schema_migrations WHERE version = 25;
        --
        -- Rollback is additive on data and subtractive on schema, but not
        -- lossless: dropping the interval column erases the only distinction
        -- between intervals, so surviving non-1h rows would either violate
        -- the restored pre-25 keys or silently blend into the 1h data. They
        -- must be preserved and handled per the preconditions above. This
        -- database has none (see backfill precondition).
    `,
};
