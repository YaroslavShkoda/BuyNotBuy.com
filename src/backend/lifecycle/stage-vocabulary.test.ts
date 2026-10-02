import { describe, expect, it } from 'vitest';

import { RuleStageSchema, checkTransition } from './promotion.config.js';

import { CANDIDATE_STAGES } from '../strategies/candidate.repository.js';
import type { CandidateStage } from '../strategies/candidate.repository.js';
import type { RuleStage } from './promotion.config.js';

const stored = new Set<string>(CANDIDATE_STAGES);
const declared = new Set<string>(RuleStageSchema.options);

/**
 * The two stage vocabularies, side by side.
 *
 * **`RuleStage` is the larger set and reaches no storage.** Migration 17 CHECKs
 * `signal_strategy_version.stage` against the seven `CANDIDATE_STAGES`, so any
 * rule the registry would move to `backtested`, `walk_forwarded`, `approved` or
 * `rejected` has nowhere to be. Every rule in production today went through the
 * candidate repository and carries the stored vocabulary.
 *
 * **This test does not resolve the disagreement, and it is not trying to.** The
 * disagreement is a decision about what a retired rule means, and it belongs to
 * the owner: `RuleStage` allows `retired → candidate` (a rule that failed can be
 * tried again on new evidence) and the stored vocabulary does not (`retired` is
 * terminal, so a rule that failed is gone). Both are defensible; they are not
 * the same policy.
 *
 * What this test does is make the conflict **reproducible and visible at the
 * point of use** — every transition the registry allows and the database would
 * refuse, named one by one. A vocabulary that can be read and enumerated is an
 * open question. Two of them drifting apart in a file nobody runs is how an
 * open question becomes a 500 at three in the morning.
 */
describe('the two stage vocabularies', () => {
    it('names every value the registry can hold and the database cannot', () => {
        const unreachable = [...declared].filter((stage) => !stored.has(stage));

        expect(unreachable.sort()).toEqual([
            'approved',
            'backtested',
            'rejected',
            'walk_forwarded',
        ]);
    });

    it('names every transition the registry allows and the database cannot store', () => {
        const unstoreable: string[] = [];

        for (const from of declared) {
            for (const to of declared) {
                if (!checkTransition(from as RuleStage, to as RuleStage).allowed) {
                    continue;
                }

                if (!stored.has(to)) {
                    unstoreable.push(`${from} → ${to}`);
                }
            }
        }

        // Seven, and I wrote five from memory before reading what the code
        // actually allows. The three that matter:
        //
        // - `candidate → backtested` is the **first rung**. Every rule that
        //   walks forward meets a name the database cannot hold before it
        //   reaches the first checkpoint.
        // - `shadow → approved` is the last one before production.
        // - Three transitions end in `rejected`, and the stored vocabulary has
        //   no word for it at all: the registry can throw a rule away, and
        //   nothing behind it can say that happened.
        expect(unstoreable.sort()).toEqual([
            'approved → rejected',
            'backtested → rejected',
            'backtested → walk_forwarded',
            'candidate → backtested',
            'shadow → approved',
            'shadow → rejected',
            'walk_forwarded → rejected',
        ]);
    });

    it('holds the disagreement open rather than closing it by accident', () => {
        // The one transition the owner's decision turns on. Pinned as a fact
        // about the code, not as a decision about the product: the stored
        // vocabulary treats `retired` as terminal and the registry does not.
        expect(checkTransition('retired', 'candidate' as RuleStage).allowed).toBe(true);
        expect(stored.has('candidate' as CandidateStage)).toBe(true);

        // And the stored table says something different, which is why this
        // pair cannot both be true of the same rule.
        const terminal: string[] = [];

        for (const to of declared) {
            if (to !== 'retired' && checkTransition('retired' as RuleStage, to as RuleStage).allowed) {
                terminal.push(to);
            }
        }

        expect(terminal).toEqual(['candidate']);
    });
});
