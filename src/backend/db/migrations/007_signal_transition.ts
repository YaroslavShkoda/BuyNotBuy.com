import type { Migration } from './types.js';

export const migration007_signal_transition: Migration = {
        version: 7,
        name: 'signal_transition',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_transition (
                id BIGSERIAL PRIMARY KEY,
                state_id BIGINT NOT NULL,
                symbol TEXT NOT NULL,
                provider TEXT NOT NULL,
                interval TEXT NOT NULL,

                from_status TEXT,
                to_status TEXT NOT NULL,
                from_direction TEXT,
                to_direction TEXT NOT NULL,

                -- Why it moved, in words a person can act on. "The panel
                -- stopped agreeing" and "the market closed against us" are
                -- different events and the performance of the strategy depends
                -- on telling them apart.
                reason TEXT NOT NULL,

                -- Candle the transition happened on, never wall time. A
                -- transition recorded against a wall clock cannot be lined up
                -- with the bars that caused it.
                candle_timestamp BIGINT NOT NULL,
                price DOUBLE PRECISION NOT NULL,
                created_at BIGINT NOT NULL,

                CONSTRAINT signal_transition_to_known CHECK (
                    to_status IN (
                        'GENERATED',
                        'ACTIVE',
                        'UPDATED',
                        'INVALIDATED',
                        'EXPIRED',
                        'CLOSED'
                    )
                ),
                CONSTRAINT signal_transition_price_positive CHECK (price > 0)
            );

            CREATE INDEX IF NOT EXISTS idx_signal_transition_state
            ON signal_transition (state_id, created_at DESC);

            -- The outcome engine reads every transition of every signal that
            -- has resolved, and there is one series of them per signal. This is
            -- the read the whole of block 18 depends on.
            CREATE INDEX IF NOT EXISTS idx_signal_transition_series
            ON signal_transition (symbol, provider, interval, created_at DESC);
        `,
    };
