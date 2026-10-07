import type { Migration } from './types.js';

export const migration002_indicator_vote: Migration = {
        version: 2,
        name: 'indicator_vote',
        sql: `
            CREATE TABLE IF NOT EXISTS indicator_vote (
                symbol TEXT NOT NULL,
                vote_bucket BIGINT NOT NULL,
                timestamp BIGINT NOT NULL,
                indicator TEXT NOT NULL,
                signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
                weight INTEGER NOT NULL CHECK (weight >= 0 AND weight <= 100),
                price DOUBLE PRECISION NOT NULL,
                fwd_return_1h DOUBLE PRECISION,
                fwd_return_4h DOUBLE PRECISION,
                fwd_return_24h DOUBLE PRECISION,
                PRIMARY KEY (symbol, vote_bucket, indicator)
            );

            -- The settlement scan filters on the unresolved horizons, so those
            -- three columns get an index of their own rather than a table scan
            -- every poller cycle.
            CREATE INDEX IF NOT EXISTS idx_indicator_vote_unsettled
            ON indicator_vote (symbol, timestamp)
            WHERE fwd_return_1h IS NULL
               OR fwd_return_4h IS NULL
               OR fwd_return_24h IS NULL;
        `,
    };
