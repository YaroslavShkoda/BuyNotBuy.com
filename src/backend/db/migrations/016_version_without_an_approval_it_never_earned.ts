import type { Migration } from './types.js';

export const migration016_version_without_an_approval_it_never_earned: Migration = {
        version: 16,
        name: 'version_without_an_approval_it_never_earned',
        sql: `
            -- Dropped rather than guarded.
            --
            -- This table carried status: 'draft' | 'approved' | 'retired' with a
            -- CHECK that accepted all three. Nothing wrote anything but 'draft',
            -- nothing tested the value — resolveActive selects by config_hash
            -- alone and never looks at the status — and the promotion ladder it
            -- copied the names of lives on strategy_rule, which this table has no
            -- foreign key to. So the column was a claim about governance that the
            -- database was willing to record on faith: one UPDATE, and a
            -- configuration that had never been walk-forwarded, let alone
            -- shadowed, would have carried the word "approved".
            --
            -- Guarding it instead of dropping it would have meant either a second
            -- vocabulary to keep in step with CandidateStage — the failure this
            -- milestone is about — or a NOT NULL reference to a stage record that
            -- does not exist for a configuration first seen at runtime. Both are
            -- worse than saying the truth: this table identifies a configuration
            -- by its hash, and whether that configuration is *allowed to run* is
            -- decided by the rule table, which is the one holding the evidence.
            --
            -- No row is altered. Every value ever stored here was the string
            -- 'draft', which carried no information, so nothing measured is lost
            -- and nothing already computed changes.
            ALTER TABLE strategy_version DROP COLUMN status;
        `,
    };
