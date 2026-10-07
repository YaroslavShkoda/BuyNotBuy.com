import type { Migration } from './types.js';

export const migration012_signal_strategy_version: Migration = {
        version: 12,
        name: 'signal_strategy_version',
        sql: `
            -- Which rule produced which signal, recorded at the time.
            --
            -- Attributing these afterwards from the current configuration
            -- would be worthless: every signal would be attributed to whatever
            -- is running now, which is exactly the confusion the table exists
            -- to prevent. A signal that cannot name the rule that produced it
            -- cannot be excluded from a calibration when that rule is retired,
            -- and excluding it later is guesswork.
            CREATE TABLE IF NOT EXISTS signal_strategy_version (
                id BIGSERIAL PRIMARY KEY,
                rule_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                parameters JSONB NOT NULL,
                promoted_at BIGINT NOT NULL,
                retired_at BIGINT,
                created_at BIGINT NOT NULL,
                CHECK (retired_at IS NULL OR retired_at >= promoted_at)
            );

            CREATE INDEX IF NOT EXISTS idx_signal_strategy_version_live
                ON signal_strategy_version (retired_at)
                WHERE retired_at IS NULL;
        `,
    };
