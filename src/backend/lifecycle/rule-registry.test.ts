import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    PromotionConfigSchema,
    DEFAULT_PROMOTION_CONFIG,
    checkTransition,
    canTransition,
    evaluateShadow,
} from './promotion.config.js';
import {
    createRule,
    advance,
    productionRules,
    activeRule,
    auditProduction,
    planRollback,
} from './rule-registry.js';

import type { RuleEvidence, RuleStage, PromotionConfig } from './promotion.config.js';
import type { Rule } from './rule-registry.js';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

const CONFIG: PromotionConfig = PromotionConfigSchema.parse({
    shadowMinimumMs: 30 * DAY,
    barIntervalMs: DAY,
    shadowMinimumSignals: 20,
    shadowRetentionMs: 365 * DAY,
    promotionMargin: -0.05,
    minimumSample: 20,
});

function evidence(overrides: Partial<RuleEvidence> = {}): RuleEvidence {
    return {
        signals: 150,
        resolved: 120,
        correct: 78,
        incorrect: 39,
        flat: 3,
        incumbentCorrect: 60,
        incumbentResolved: 120,
        firstSeenAt: NOW - 60 * DAY,
        lastSeenAt: NOW,
        ...overrides,
    };
}

function rule(id: string, now = NOW): Rule {
    return createRule({ id, rationale: `правило ${id}`, now, parameters: { a: 1 } });
}

/** Walks a rule up to a stage, or stops early and returns what it got. */
function walkTo(stage: RuleStage, start = rule('r')): Rule {
    const path: RuleStage[] = [
        'candidate',
        'backtested',
        'walk_forwarded',
        'shadow',
        'approved',
        'production',
    ];
    let current = start;

    for (const next of path.slice(1, path.indexOf(stage) + 1)) {
        const decision = advance(
            current,
            next,
            NOW,
            CONFIG,
            next === 'approved' ? evidence() : undefined,
        );

        if (!decision.applied) {
            throw new Error(`could not reach ${stage}: ${decision.reason}`);
        }

        current = decision.rule;
    }

    return current;
}

describe('the order of the stages is the design', () => {
    it('refuses to skip from candidate straight to production', () => {
        // The whole point of the ladder. A rule that could jump to production
        // would pass every check that does not happen to be on that jump.
        const check = checkTransition('candidate', 'production');

        expect(check.allowed).toBe(false);
        expect(check.reason).toMatch(/переход/);
    });

    it('refuses to go backwards up the ladder', () => {
        expect(checkTransition('production', 'shadow').allowed).toBe(false);
        expect(checkTransition('approved', 'candidate').allowed).toBe(false);
    });

    it('refuses a move to the stage a rule is already in', () => {
        expect(checkTransition('shadow', 'shadow').reason).toMatch(/уже находится/);
    });

    it('always allows a way down, including from production', () => {
        // A rule that is losing money has to be stoppable at any moment, and a
        // promotion policy with no way down is not a promotion policy.
        expect(canTransition('production', 'retired')).toBe(true);
        expect(canTransition('approved', 'rejected')).toBe(true);
        expect(canTransition('walk_forwarded', 'rejected')).toBe(true);
    });

    it('lets a rejected rule start again from the beginning', () => {
        expect(canTransition('rejected', 'candidate')).toBe(true);
    });

    it('has no forward path out of rejected other than the start', () => {
        expect(canTransition('rejected', 'production')).toBe(false);
        expect(canTransition('rejected', 'approved')).toBe(false);
    });

    it('refuses a shadow window that is too short to collect what it demands', () => {
        // 200 signals at a daily bar is 200 days. A 1000ms window cannot
        // produce them, and a rule blocked by arithmetic rather than by
        // evidence is the most demoralising possible reason to wait.
        expect(() =>
            PromotionConfigSchema.parse({
                shadowMinimumMs: 1000,
                barIntervalMs: DAY,
                shadowMinimumSignals: 200,
                shadowRetentionMs: 1,
                promotionMargin: -0.01,
                minimumSample: 5,
            }),
        ).toThrow(/too short to collect/);
    });

    it('accepts a window that can actually produce its signals', () => {
        expect(() =>
            PromotionConfigSchema.parse({
                shadowMinimumMs: 200 * DAY,
                barIntervalMs: DAY,
                shadowMinimumSignals: 200,
                shadowRetentionMs: 1,
                promotionMargin: -0.01,
                minimumSample: 5,
            }),
        ).not.toThrow();
    });

    it('refuses a margin that would promote the incumbent into itself', () => {
        expect(() =>
            PromotionConfigSchema.parse({
                shadowMinimumMs: DAY,
                shadowMinimumSignals: 5,
                shadowRetentionMs: DAY,
                promotionMargin: 0.02,
                minimumSample: 5,
            }),
        ).toThrow();
    });
});

describe('a shadowed rule is judged on three separate things', () => {
    it('says it needs more signals rather than saying it is bad', () => {
        // "Not ready" is not an answer a reader can act on. Waiting and
        // stopping call for completely different reactions.
        const verdict = evaluateShadow(
            evidence({ signals: 8, resolved: 6 }),
            CONFIG,
            NOW,
        );

        expect(verdict.ready).toBe(false);
        expect(verdict.reason).toMatch(/недостаточно/);
        expect(verdict.outstanding.join()).toMatch(/сигналов 8, нужно 20/);
    });

    it('says how long it still has to wait', () => {
        const verdict = evaluateShadow(
            evidence({ firstSeenAt: NOW - 5 * DAY }),
            CONFIG,
            NOW,
        );

        expect(verdict.outstanding.join()).toMatch(/5 дн\., нужно 30/);
    });

    it('names the shortfall when the evidence is there and the rule loses', () => {
        const verdict = evaluateShadow(
            evidence({ correct: 61, incumbentCorrect: 70 }),
            CONFIG,
            NOW,
        );

        // 61 out of 120 is 50.8% against 58.3%: real, and five points short
        // of the margin. The reader is told the number and the gap.
        expect(verdict.ready).toBe(false);
        expect(verdict.reason).toMatch(/не хватает 5\.0 п\.п\./);
    });

    it('refuses to promote against a rule that produced no evidence', () => {
        // A rule promoted against nothing is a rule whose comparison was never
        // made, and the record would then say it beat the incumbent.
        const verdict = evaluateShadow(
            evidence({ incumbentResolved: 0, incumbentCorrect: 0 }),
            CONFIG,
            NOW,
        );

        expect(verdict.ready).toBe(false);
        expect(verdict.reason).toMatch(/не с чем сравнивать/);
    });

    it('refuses to judge on a handful of resolved signals', () => {
        const verdict = evaluateShadow(
            evidence({ signals: 500, resolved: 3, correct: 3 }),
            CONFIG,
            NOW,
        );

        expect(verdict.outstanding.join()).toMatch(/разрешено 3, нужно минимум 20/);
    });

    it('approves a rule that earned it, and says by how much', () => {
        const verdict = evaluateShadow(evidence(), CONFIG, NOW);

        expect(verdict.ready).toBe(true);
        expect(verdict.reason).toMatch(/65\.0% против 50\.0%/);
        expect(verdict.reason).toMatch(/120 разрешённых/);
    });
});

describe('a rule that cannot state why it exists is refused', () => {
    it('requires a rationale at creation', () => {
        expect(() =>
            createRule({ id: 'x', rationale: '', now: NOW, parameters: {} }),
        ).toThrow();
    });

    it('keeps the rationale with the rule for its whole life', () => {
        const live = walkTo('production');

        expect(live.rationale).toMatch(/правило r/);
    });
});

describe('the engine moves a rule and records why', () => {
    it('takes a rule all the way to production', () => {
        const live = walkTo('production');

        expect(live.stage).toBe('production');
        expect(live.history).toHaveLength(5);
    });

    it('records every step, with what it was and where it went', () => {
        const live = walkTo('production');

        expect(live.history.map((entry) => entry.to)).toEqual([
            'backtested',
            'walk_forwarded',
            'shadow',
            'approved',
            'production',
        ]);
        expect(live.history[0]?.from).toBe('candidate');
    });

    it('attaches the evidence to the step that was decided on it', () => {
        const live = walkTo('production');
        const approved = live.history.find((entry) => entry.to === 'approved');

        expect(approved?.evidence?.resolved).toBe(120);
    });

    it('leaves a stage that moved on evidence free of evidence', () => {
        // Its absence is meaningful: a stage moved without evidence is a stage
        // somebody walked past, and a reader can now see which ones those are.
        const live = walkTo('production');

        expect(live.history.find((entry) => entry.to === 'shadow')?.evidence).toBeUndefined();
    });

    it('leaves the record completely untouched when it refuses', () => {
        const shadowed = walkTo('shadow');
        const decision = advance(shadowed, 'approved', NOW, CONFIG);

        // A history entry for a transition that did not happen would pad the
        // trail with attempts and hide the fact that the guardrail held.
        expect(decision.applied).toBe(false);
        expect(decision.rule).toBe(shadowed);
        expect(decision.rule.history).toHaveLength(3);
    });

    it('says what was missing when it refuses an approval', () => {
        const shadowed = walkTo('shadow');
        const decision = advance(
            shadowed,
            'approved',
            NOW,
            CONFIG,
            evidence({ signals: 5, resolved: 2 }),
        );

        expect(decision.reason).toMatch(/не одобрено/);
        expect(decision.reason).toMatch(/нужно 20/);
    });

    it('refuses to walk past a stage in one jump', () => {
        const candidate = rule('r');
        const decision = advance(candidate, 'shadow', NOW, CONFIG);

        expect(decision.applied).toBe(false);
        expect(decision.rule.stage).toBe('candidate');
    });
});

describe('only production rules are allowed to affect anything', () => {
    it('returns nothing while every rule is in shadow', () => {
        const rules = [walkTo('shadow', rule('a')), walkTo('shadow', rule('b'))];

        expect(productionRules(rules)).toEqual([]);
        expect(activeRule(rules)).toBeNull();
    });

    it('returns exactly the one that is live', () => {
        const rules = [walkTo('shadow', rule('a')), walkTo('production', rule('b'))];

        expect(productionRules(rules).map((found) => found.id)).toEqual(['b']);
    });

    it('reports two live rules instead of quietly picking one', () => {
        const rules = [walkTo('production', rule('a')), walkTo('production', rule('b'))];
        const report = auditProduction(rules);

        // Picking one silently would make a promotion bug look like a
        // strategy change, and that is the exact disguise it would take.
        expect(report.conflict).toBe(true);
        expect(report.ids).toEqual(['a', 'b']);
        expect(report.reason).toMatch(/не должно оставлять второе/);
    });

    it('is clean with one rule', () => {
        expect(auditProduction([walkTo('production')]).conflict).toBe(false);
    });
});

describe('rollback puts back the rule that was there before', () => {
    it('does nothing when nothing is live', () => {
        expect(planRollback([walkTo('shadow')], NOW, CONFIG)).toBeNull();
    });

    it('says out loud when there is no previous rule to go back to', () => {
        const plan = planRollback([walkTo('production', rule('only'))], NOW, CONFIG);

        // A rollback that silently leaves the system with no rule would report
        // itself as a success.
        expect(plan?.restored).toBeNull();
        expect(plan?.reason).toMatch(/сигналы не будут генерироваться вовсе/);
    });

    it('retires the live rule and names the one it goes back to', () => {
        // Two rules in turn, both walked all the way up. The first is retired
        // before the second goes live, which is the ordinary sequence and the
        // one a rollback has to work for.
        const firstLive = walkTo('production', rule('first'));
        const firstRetired = advance(firstLive, 'retired', NOW + 60_000, CONFIG)
            .rule;
        const secondCandidate = walkTo('shadow', rule('second'));
        const secondApproved = advance(
            secondCandidate,
            'approved',
            NOW + 60_000,
            CONFIG,
            evidence(),
        ).rule;
        const secondLive = advance(
            secondApproved,
            'production',
            NOW + 120_000,
            CONFIG,
        ).rule;

        const plan = planRollback(
            [firstRetired, secondLive],
            NOW + 180_000,
            CONFIG,
        );

        expect(plan?.retired.id).toBe('second');
        expect(plan?.retired.stage).toBe('retired');
        expect(plan?.restored?.id).toBe('first');
        expect(plan?.reason).toMatch(/откат на first/);
    });

    it('refuses to guess when two older rules entered production at the same instant', () => {
        // Two rules promoted in the same millisecond, then a third later. The
        // trail orders within one rule and not between two, so the two older
        // ones are genuinely indistinguishable. Guessing would produce a
        // rollback that looks like it worked and restores somebody else's rule.
        const walkAt = (id: string, at: number) => {
            let current = rule(id, at);

            for (const stage of ['backtested', 'walk_forwarded', 'shadow', 'approved', 'production'] as const) {
                current = advance(
                    current,
                    stage,
                    at,
                    CONFIG,
                    stage === 'approved' ? evidence() : undefined,
                ).rule;
            }

            return current;
        };

        const first = advance(walkAt('first', NOW), 'retired', NOW + 1_000, CONFIG)
            .rule;
        const second = advance(
            walkAt('second', NOW),
            'retired',
            NOW + 1_000,
            CONFIG,
        ).rule;
        const third = walkAt('third', NOW + 60_000);

        const plan = planRollback([first, second, third], NOW + 120_000, CONFIG);

        expect(plan?.restored).toBeNull();
        expect(plan?.reason).toMatch(/не определено/);
        expect(plan?.reason).toMatch(/в один момент/);
    });

    it('finds the previous rule by walking the trail, not by a stored pointer', () => {
        // A stored pointer goes stale the moment a rule is retired and then
        // reinstated, and a rollback that restores a rule nobody can name is
        // worse than no rollback.
        const original = walkTo('production', rule('original'));
        const retired = advance(original, 'retired', NOW, CONFIG).rule;

        expect(
            retired.history.some((entry) => entry.to === 'production'),
        ).toBe(true);
    });
});

describe('the ladder holds for any sequence anybody can walk', () => {
    it('never lets a rule skip a stage, whatever it is asked to do', () => {
        const path: RuleStage[] = [
            'candidate',
            'backtested',
            'walk_forwarded',
            'shadow',
            'approved',
            'production',
        ];

        fc.assert(
            fc.property(
                fc.constantFrom<RuleStage>(...path),
                fc.constantFrom<RuleStage>(
                    'candidate',
                    'backtested',
                    'walk_forwarded',
                    'shadow',
                    'approved',
                    'production',
                    'rejected',
                    'retired',
                ),
                (from, to) => {
                    const before = walkTo(from, rule('r'));
                    const decision = advance(before, to, NOW, CONFIG, evidence());

                    if (canTransition(from, to)) {
                        expect(decision.applied).toBe(true);
                        expect(decision.rule.stage).toBe(to);
                        return;
                    }

                    // Whatever was refused, the rule stayed exactly where it
                    // was. The engine's only job is that a refusal changes
                    // nothing at all.
                    expect(decision.applied).toBe(false);
                    expect(decision.rule).toBe(before);
                },
            ),
            { numRuns: 48 },
        );
    });

    it('records more history the further a rule goes, never less', () => {
        const path: RuleStage[] = [
            'candidate',
            'backtested',
            'walk_forwarded',
            'shadow',
            'approved',
            'production',
        ];

        fc.assert(
            fc.property(fc.integer({ min: 0, max: 5 }), (steps) => {
                let current = rule('r');
                const seen: number[] = [0];

                for (const stage of path.slice(1, steps + 1)) {
                    const decision = advance(
                        current,
                        stage,
                        NOW,
                        CONFIG,
                        stage === 'approved' ? evidence() : undefined,
                    );
                    current = decision.rule;
                    seen.push(current.history.length);
                }

                for (let index = 1; index < seen.length; index += 1) {
                    expect(seen[index]!).toBeGreaterThan(seen[index - 1]!);
                }
            }),
            { numRuns: 20 },
        );
    });

    it('never reports a conflict when only one rule can be live', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 5 }), (count) => {
                const rules = Array.from({ length: count }, (_, index) =>
                    walkTo('production', rule(`r${index}`)),
                );

                expect(auditProduction(rules).conflict).toBe(count > 1);
            }),
            { numRuns: 10 },
        );
    });
});

describe('the shipped configuration is one that can actually be met', () => {
    it('collects enough signals in the window it asks for', () => {
        expect(DEFAULT_PROMOTION_CONFIG.shadowMinimumSignals).toBeGreaterThan(0);
        expect(DEFAULT_PROMOTION_CONFIG.promotionMargin).toBeLessThan(0);
    });
});
