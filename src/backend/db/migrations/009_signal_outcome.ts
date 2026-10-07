import type { Migration } from './types.js';

export const migration009_signal_outcome: Migration = {
        version: 9,
        name: 'signal_outcome',
        sql: `
            -- What became of each signal, at each horizon.
            --
            -- One row per signal per horizon rather than columns per horizon.
            -- The horizon list is configurable, so a fixed set of columns
            -- would mean a migration every time an operator wants to measure
            -- further out, and the measurement someone runs later would be a
            -- different database from the one the strategy was judged on.
            --
            -- The return is stored signed in the direction of the signal: a long
            -- that gained five percent and a short that fell five percent are
            -- the same result, and a table that stores raw prices makes every
            -- reader reconstruct the direction on its own.
            CREATE TABLE IF NOT EXISTS signal_outcome (
                id BIGSERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                provider TEXT NOT NULL,
                interval TEXT NOT NULL,
                signal_state_id BIGINT,
                direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
                verdict TEXT NOT NULL CHECK (verdict IN (
                    'correct', 'incorrect', 'flat', 'unknown', 'expired'
                )),
                horizon_bars INTEGER NOT NULL CHECK (horizon_bars > 0),
                entry_timestamp BIGINT NOT NULL,
                entry_price DOUBLE PRECISION NOT NULL CHECK (entry_price > 0),
                exit_timestamp BIGINT,
                exit_price DOUBLE PRECISION,
                return_fraction DOUBLE PRECISION,
                max_favourable DOUBLE PRECISION,
                max_adverse DOUBLE PRECISION,
                closed_by TEXT CHECK (
                    closed_by IS NULL
                    OR closed_by IN ('invalidated', 'expired', 'reversed')
                ),
                regime TEXT,
                data_quality DOUBLE PRECISION,
                strategy_version_id BIGINT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                -- One measurement per signal per horizon. Re-measuring the same
                -- signal updates the row rather than appending, so a signal
                -- that was unresolved becomes resolved in place and a report
                -- over the table never counts the same trade twice.
                UNIQUE (symbol, provider, interval, signal_state_id, horizon_bars)
            );

            -- The read a performance table does, over and over: every resolved
            -- signal for one series at one horizon.
            CREATE INDEX IF NOT EXISTS idx_signal_outcome_series
            ON signal_outcome (
                symbol, provider, interval, horizon_bars, verdict
            )
            WHERE verdict IN ('correct', 'incorrect', 'flat');

            -- Grouping a performance table by regime is the whole reason the
            -- column is carried down from the history onto every measurement.
            CREATE INDEX IF NOT EXISTS idx_signal_outcome_regime
            ON signal_outcome (symbol, provider, interval, regime, horizon_bars)
            WHERE regime IS NOT NULL;

            -- Everything unresolved, oldest first. The settlement scan reads
            -- exactly this set on every run, and it is a small fraction of the
            -- table, so the partial index is worth more than a full one.
            CREATE INDEX IF NOT EXISTS idx_signal_outcome_unresolved
            ON signal_outcome (entry_timestamp, id)
            WHERE verdict IN ('unknown', 'expired');
        `,
    };
