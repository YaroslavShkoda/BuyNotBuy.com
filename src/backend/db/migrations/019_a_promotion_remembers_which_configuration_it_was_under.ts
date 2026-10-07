import type { Migration } from './types.js';

export const migration019_a_promotion_remembers_which_configuration_it_was_under: Migration = {
        version: 19,
        name: 'a_promotion_remembers_which_configuration_it_was_under',
        sql: `
            -- The two halves of this system never met.
            --
            -- Measurements are filed under strategy_version, which is a
            -- fingerprint of the indicator configuration: periods, thresholds
            -- and which rules are installed. signal_outcome.strategy_version_id
            -- points there, and so does signal_snapshot.
            --
            -- The promotion ladder lives in signal_strategy_version, keyed by
            -- rule_id, holding the rule's own parameters. Nothing anywhere
            -- recorded that "this rule, at this stage, was running that
            -- configuration", so the evidence gate could not be wired even with
            -- perfect data: there was no join to make.
            --
            -- **The two are not the same thing, and the column says which is
            -- which.** This is the configuration version in force at the moment
            -- of promotion, NOT the rule's parameters. Those live in different
            -- spaces -- a rule whose parameters are {channelPeriod: 20} has no
            -- representation in strategy_version.config at all, so a
            -- fingerprint of the parameters would match no version and could
            -- not be substituted for this column.
            ALTER TABLE signal_strategy_version
                ADD COLUMN IF NOT EXISTS strategy_version_id BIGINT
                    REFERENCES strategy_version (id);

            -- Nullable on purpose, and the reason is the same as everywhere
            -- else: a promotion recorded before this migration genuinely does
            -- not know which configuration it was under, and "unknown" written
            -- as a number would be a fabricated provenance that no reader could
            -- tell from a real one. No row is rewritten, and a null here is a
            -- state the evidence gate has to refuse rather than a gap to fill.
            CREATE INDEX IF NOT EXISTS idx_signal_strategy_version_config
            ON signal_strategy_version (strategy_version_id)
            WHERE strategy_version_id IS NOT NULL;
        `,
    };
