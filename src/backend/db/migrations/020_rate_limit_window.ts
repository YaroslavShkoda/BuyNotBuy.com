import type { Migration } from './types.js';

export const migration020_rate_limit_window: Migration = {
        version: 20,
        name: 'rate_limit_window',
        sql: `
            -- The request-limit counter, moved out of process memory into the
            -- only place two processes already share.
            --
            -- In memory, the window was a Map entry, and a Map entry per
            -- process meant the budget was the limit times the number of
            -- instances — the more of the system there was, the less the
            -- limit meant. Here it is one row per client per window, and the
            -- statement that serves a request either inserts count = 1 or
            -- adds one, under the row lock, atomically: two instances
            -- answering the same client in the same millisecond serialize and
            -- each sees the total, not its own half.
            --
            -- window_start is epoch milliseconds, like every other clock in
            -- this schema, and it is the aligned start of the window rather
            -- than the first request's timestamp: every process computes the
            -- same value from the same wall clock, which is what lands their
            -- writes on one row.
            --
            -- The row dies with its window. A window that has ended can never
            -- be joined again — the ON CONFLICT target is (bucket,
            -- window_start) — so it is swept by the same policy machinery as
            -- every other table, one day kept for incident forensics.
            CREATE TABLE IF NOT EXISTS rate_limit_window (
                bucket TEXT NOT NULL,
                window_start BIGINT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (bucket, window_start)
            );
        `,
    };
