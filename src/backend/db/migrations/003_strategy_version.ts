import type { Migration } from './types.js';

export const migration003_strategy_version: Migration = {
        version: 3,
        name: 'strategy_version',
        sql: `
            CREATE TABLE IF NOT EXISTS strategy_version (
                id BIGSERIAL PRIMARY KEY,
                created_at BIGINT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                config JSONB NOT NULL,
                config_hash TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'approved', 'retired'))
            );

            -- A version is identified by what it says, not by when it was
            -- written. Two builds with identical indicator settings must not be
            -- able to create two versions, because a snapshot stored under one
            -- of them would then claim provenance the other claims too, and the
            -- two could not be told apart when the results are read back months
            -- later.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_version_active
            ON strategy_version (config_hash)
            WHERE status <> 'retired';
        `,
    };
