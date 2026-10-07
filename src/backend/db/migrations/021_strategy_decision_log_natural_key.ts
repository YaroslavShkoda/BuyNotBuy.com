import type { Migration } from './types.js';

export const migration021_strategy_decision_log_natural_key: Migration = {
        version: 21,
        name: 'strategy_decision_log_natural_key',
        sql: `
            -- One decision per asset per cycle, enforced by the pair that
            -- names it.
            --
            -- Until now the table's only key was the surrogate id, which made
            -- every repeat of a write a second row: the same decision inserted
            -- twice looked like two decisions, and the agreement rate a
            -- promotion is judged by silently counted some cycles heavier than
            -- others. The natural key of a decision is (symbol, created_at) --
            -- the loop decides once per asset per cycle -- and this index is
            -- the statement of that fact the database can hold the code to.
            --
            -- It is also what makes a write safe to repeat. The decision log
            -- is now buffered against transient database failures, and a
            -- buffered write is by definition a write that may be attempted
            -- more than once; ON CONFLICT DO NOTHING turns that replay into a
            -- no-op instead of a duplicate, so a retry can never inflate the
            -- evidence with a cycle that was already counted.
            CREATE UNIQUE INDEX IF NOT EXISTS ux_strategy_decision_log_symbol_cycle
                ON strategy_decision_log (symbol, created_at);
        `,
    };
