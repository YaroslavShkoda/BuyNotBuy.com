import type { Migration } from './types.js';

export const migration013_strategy_decision_log: Migration = {
        version: 13,
        name: 'strategy_decision_log',
        sql: `
            -- What every strategy said, every cycle, including the ones that
            -- were not published.
            --
            -- A shadow period that does not write anything down is not a shadow
            -- period, it is a guess. The fallback in this system is evaluated on
            -- every analysis and held back, and the number worth watching is how
            -- often it would have disagreed with the primary — but that number
            -- was previously returned to a caller and immediately dropped, so
            -- there was nothing to watch and nothing to decide a promotion on.
            --
            -- Deliberately additive and deliberately not a new column on
            -- signal_snapshot. The snapshot's payload is MarketAnalysis, which
            -- is the frozen contract the dashboard reads; putting backend
            -- bookkeeping inside it would change what a client parses.
            --
            -- Both answers are stored, not just the published one. Storing only
            -- the published answer would make the disagreement impossible to
            -- reconstruct, which is the entire reason for the table.
            CREATE TABLE IF NOT EXISTS strategy_decision_log (
                id BIGSERIAL PRIMARY KEY,
                created_at BIGINT NOT NULL,
                symbol TEXT NOT NULL,
                strategy_version_id BIGINT
                    REFERENCES strategy_version (id) ON DELETE RESTRICT,

                primary_rule TEXT NOT NULL,
                primary_direction TEXT NOT NULL,
                primary_confidence INTEGER NOT NULL,

                fallback_rule TEXT,
                fallback_direction TEXT,
                fallback_confidence INTEGER,

                published_rule TEXT NOT NULL,
                published_direction TEXT NOT NULL,

                -- True when the fallback had an opinion and was not allowed to
                -- publish it. The count of this is the evidence a promotion
                -- decision is supposed to rest on.
                suppressed BOOLEAN NOT NULL DEFAULT FALSE,

                CONSTRAINT strategy_decision_log_direction
                    CHECK (primary_direction IN ('LONG', 'SHORT', 'NEUTRAL')),

                CONSTRAINT strategy_decision_log_fallback_direction
                    CHECK (
                        fallback_direction IS NULL
                        OR fallback_direction IN ('LONG', 'SHORT', 'NEUTRAL')
                    ),

                CONSTRAINT strategy_decision_log_published_direction
                    CHECK (published_direction IN ('LONG', 'SHORT', 'NEUTRAL')),

                -- A suppression without a fallback answer is not a decision
                -- anybody could have made, and a stored one would be a row that
                -- says something happened when nothing did.
                CONSTRAINT strategy_decision_log_suppression_means_voice
                    CHECK (NOT suppressed OR fallback_direction IS NOT NULL)
            );

            CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_time
                ON strategy_decision_log (created_at DESC);

            -- The query a reviewer actually runs: what did the fallback say,
            -- and how often was it overruled.
            CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_rule
                ON strategy_decision_log (fallback_rule, created_at DESC)
                WHERE fallback_rule IS NOT NULL;
        `,
    };
