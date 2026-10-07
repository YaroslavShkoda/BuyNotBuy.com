import type { Migration } from './types.js';

export const migration017_stage_must_be_a_stage: Migration = {
        version: 17,
        name: 'stage_must_be_a_stage',
        sql: `
            -- The promotion ladder, in the place the ladder is actually kept.
            --
            -- signal_strategy_version.stage was NOT NULL text with no CHECK, so
            -- the one column that records how far a rule got would have taken
            -- the word "production" from a rule that was still a candidate, or
            -- "banana" from a typo, and the database would not have cared. The
            -- order is checked in TypeScript by canTransition, which is the right
            -- place to check order — a CHECK cannot know what came before. But
            -- the vocabulary itself is a closed set, and letting a column widen
            -- itself is how a second dialect starts: the ladder names a stage,
            -- the column quietly accepts whatever the caller had.
            --
            -- The seven values are exactly CANDIDATE_STAGES in
            -- strategies/candidate.repository.ts, in that order. That vocabulary
            -- is authoritative here because it is the one with a table behind it;
            -- RuleStage in lifecycle/promotion.config.ts is a different, larger
            -- set that reaches no storage at all. Recorded rather than merged —
            -- the two disagree on policy, and that disagreement is a decision
            -- about what a retired rule means, not a spelling fix.
            --
            -- The table holds no rows, so nothing is rewritten.
            ALTER TABLE signal_strategy_version
                DROP CONSTRAINT IF EXISTS signal_strategy_version_stage_check;
            ALTER TABLE signal_strategy_version
                ADD CONSTRAINT signal_strategy_version_stage_check
                CHECK (stage = ANY (ARRAY[
                    'candidate',
                    'backtest',
                    'walk-forward',
                    'shadow',
                    'approval',
                    'production',
                    'retired'
                ]));
        `,
    };
