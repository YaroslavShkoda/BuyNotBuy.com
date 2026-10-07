import type { Migration } from './types.js';

export const migration001_signal_history: Migration = {
        version: 1,
        name: 'signal_history',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_history (
                symbol TEXT NOT NULL,
                hour_bucket BIGINT NOT NULL,
                timestamp BIGINT NOT NULL,
                signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
                consensus INTEGER NOT NULL CHECK (consensus >= 0 AND consensus <= 100),
                price DOUBLE PRECISION NOT NULL,
                PRIMARY KEY (symbol, hour_bucket)
            )
        `,
    };
