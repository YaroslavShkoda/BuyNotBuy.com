import type { Migration } from './types.js';

export const migration004_signal_snapshot: Migration = {
        version: 4,
        name: 'signal_snapshot',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_snapshot (
                id BIGSERIAL PRIMARY KEY,
                created_at BIGINT NOT NULL,
                symbol TEXT NOT NULL,
                strategy_version_id BIGINT NOT NULL
                    REFERENCES strategy_version (id) ON DELETE RESTRICT,
                input_hash TEXT NOT NULL,
                snapshot JSONB NOT NULL,
                first_candle_ts BIGINT NOT NULL,
                last_candle_ts BIGINT NOT NULL,
                candle_count INTEGER NOT NULL,
                candles_hash TEXT NOT NULL,

                -- The point of the table. A snapshot that can be edited is one
                -- that can be made to agree with a result measured weeks later,
                -- which is the single thing that would make every walk-forward
                -- and shadow number in the system meaningless. RESTRICT on the
                -- strategy version for the same reason: retiring a version must
                -- not take its evidence with it.
                UNIQUE (symbol, input_hash)
            );

            -- Outcomes are joined to snapshots by id, and an operator asking
            -- "what did it say at the time?" reads the newest ones.
            CREATE INDEX IF NOT EXISTS idx_signal_snapshot_created
            ON signal_snapshot (symbol, created_at DESC);
        `,
    };
