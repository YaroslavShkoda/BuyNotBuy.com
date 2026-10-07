import type { Migration } from './types.js';

export const migration010_retention_policy: Migration = {
        version: 10,
        name: 'retention_policy',
        sql: `
            -- What the system is willing to forget, recorded rather than
            -- configured in code.
            --
            -- A retention rule that lives in a constant cannot be inspected
            -- from outside, and "how long do we keep this" is a question whose
            -- answer changes what a person may ask the database. The rows here
            -- are the rules; the pruner reads them, and a reader can read them
            -- too.
            --
            -- What gets deleted is the evidence every calibration figure was
            -- computed from. That is not a storage decision, it is deleting the
            -- measurements, and once the candles behind them are gone there is
            -- no getting it back.
            CREATE TABLE IF NOT EXISTS retention_policy (
                table_name TEXT PRIMARY KEY,
                keep_days INTEGER NOT NULL CHECK (keep_days > 0),
                -- Why this number, in the author's words. A retention rule
                -- without a reason is a number somebody typed once.
                rationale TEXT NOT NULL,
                updated_at BIGINT NOT NULL
            );

            -- What the pruner actually did, and when.
            CREATE TABLE IF NOT EXISTS retention_run (
                id BIGSERIAL PRIMARY KEY,
                table_name TEXT NOT NULL,
                started_at BIGINT NOT NULL,
                finished_at BIGINT NOT NULL,
                cutoff BIGINT NOT NULL,
                deleted_rows BIGINT NOT NULL,
                duration_ms BIGINT NOT NULL,
                -- Rows that could not be deleted and why. Deleting the parent
                -- of a row somebody still references is not a pruning
                -- decision, it is data loss, and it is counted rather than
                -- attempted.
                skipped BIGINT NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_retention_run_table
                ON retention_run (table_name, finished_at DESC);
        `,
    };
