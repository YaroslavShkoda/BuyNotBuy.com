import type { Migration } from './types.js';

export const migration026_decision_confidence_precision: Migration = {
    version: 26,
    name: 'decision_confidence_precision',
    sql: `
        -- StrategyDecision confidence can be fractional. Keep its JavaScript
        -- number value, and preserve legacy integer percentages without scaling.
        -- This ALTER can rewrite the table and takes ACCESS EXCLUSIVE: schedule
        -- an owner-approved migration window for a populated deployment.
        ALTER TABLE strategy_decision_log
            ALTER COLUMN primary_confidence TYPE DOUBLE PRECISION
                USING primary_confidence::DOUBLE PRECISION,
            ALTER COLUMN fallback_confidence TYPE DOUBLE PRECISION
                USING fallback_confidence::DOUBLE PRECISION;

        -- INTEGER rejected non-finite inputs. Widen precision without allowing
        -- NaN/infinity to become stored confidence; NULL fallback stays valid.
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'strategy_decision_log'::regclass
                  AND conname = 'strategy_decision_log_primary_confidence_finite'
            ) THEN
                ALTER TABLE strategy_decision_log
                    ADD CONSTRAINT strategy_decision_log_primary_confidence_finite
                    CHECK (primary_confidence NOT IN
                        ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION));
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'strategy_decision_log'::regclass
                  AND conname = 'strategy_decision_log_fallback_confidence_finite'
            ) THEN
                ALTER TABLE strategy_decision_log
                    ADD CONSTRAINT strategy_decision_log_fallback_confidence_finite
                    CHECK (fallback_confidence NOT IN
                        ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION));
            END IF;
        END $$;
    `,
};
