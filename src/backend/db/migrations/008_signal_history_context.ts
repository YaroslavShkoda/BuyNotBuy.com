import type { Migration } from './types.js';

export const migration008_signal_history_context: Migration = {
        version: 8,
        name: 'signal_history_context',
        sql: `
            -- Everything needed to ask "what was true when this signal was
            -- published", which is the question every performance number
            -- depends on and the one the original table could not answer.
            --
            -- Added by ALTER rather than by rewriting the table: the rows
            -- already recorded are measurements, and a rule this system holds
            -- itself to is that old results are never rewritten. The new
            -- columns are nullable for exactly that reason — a row from before
            -- this migration has no regime, and saying so is honest where
            -- guessing would not be.
            ALTER TABLE signal_history
                ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'unknown',
                ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT 'unknown',
                ADD COLUMN IF NOT EXISTS regime TEXT,
                ADD COLUMN IF NOT EXISTS data_quality DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS data_quality_usable BOOLEAN,
                ADD COLUMN IF NOT EXISTS data_quality_worst TEXT,
                ADD COLUMN IF NOT EXISTS signal_state_id BIGINT;

            -- The identity has to carry the series, not just the symbol. With
            -- one series per symbol, the primary key is right; the moment a
            -- second interval is analysed, every write for it collides with the
            -- first one's row and overwrites it. Recomputing the key and
            -- dropping the old constraint is the honest fix — the uniqueness
            -- that was there was uniqueness over too little.
            --
            -- Done in place rather than by a new table so the rows measured so
            -- far are carried forward rather than abandoned.
            ALTER TABLE signal_history
                DROP CONSTRAINT IF EXISTS signal_history_pkey;
            ALTER TABLE signal_history
                ADD PRIMARY KEY (symbol, provider, interval, hour_bucket);

            -- The read that the performance table does, over and over: every
            -- signal for one series in a window. Everything before this was a
            -- scan of the whole table for every question asked of it.
            CREATE INDEX IF NOT EXISTS idx_signal_history_series_time
            ON signal_history (symbol, provider, interval, timestamp DESC);

            -- Grouping a performance table by regime is the whole reason the
            -- column exists, and it is a filter on a large share of the rows,
            -- so it is worth its own index rather than being discovered by a
            -- query plan during a report.
            CREATE INDEX IF NOT EXISTS idx_signal_history_regime
            ON signal_history (symbol, provider, interval, regime, timestamp DESC)
            WHERE regime IS NOT NULL;
        `,
    };
