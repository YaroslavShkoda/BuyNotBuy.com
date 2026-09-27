import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    buildWalkForwardPlan,
    auditWalkForwardPlan,
    judgeFold,
    DEFAULT_VALIDATION_RATIO,
    DEFAULT_VALIDATION_TOLERANCE,
} from './walk-forward.plan.js';
import { DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { requiredCandleCount } from '../config/indicator.config.js';

import type { WalkForwardPlan } from './walk-forward.plan.js';

const CANDLES = 2934;

function plan(
    candleCount = CANDLES,
    overrides: Partial<typeof DEFAULT_WALK_FORWARD_OPTIONS> = {},
    ratio = DEFAULT_VALIDATION_RATIO,
): WalkForwardPlan {
    return buildWalkForwardPlan(
        candleCount,
        { ...DEFAULT_WALK_FORWARD_OPTIONS, ...overrides },
        { validationRatio: ratio },
    );
}

describe('the plan is data, so the windows can be checked', () => {
    it('puts every test window strictly after everything it was fitted on', () => {
        const result = plan();

        for (const fold of result.folds) {
            expect(fold.test.startIndex).toBeGreaterThan(fold.train.endIndex);
            expect(fold.test.startIndex).toBeGreaterThan(fold.validate.endIndex);
        }
    });

    it('takes the validation window out of the training span, not after it', () => {
        // Extra data would be nice, but it is not available: the bars before a
        // fold's test window are the bars the fold was given. Taking validation
        // from inside means the fold's total history stays the same length.
        const result = plan();
        const [first] = result.folds;

        expect(first?.train.endIndex).toBe(first!.validate.startIndex - 1);
        expect(first?.validate.endIndex).toBe(first!.test.startIndex - 1);
    });

    it('keeps the warm-up prefix out of every window', () => {
        const result = plan();

        for (const fold of result.folds) {
            expect(fold.train.startIndex).toBeGreaterThan(result.warmup.endIndex);
        }
    });

    it('refuses a validation share that would leave nothing to fit on', () => {
        expect(() => plan(CANDLES, {}, 1)).toThrow(/chosen on nothing/);
        expect(() => plan(CANDLES, {}, -0.1)).toThrow();
    });

    it('produces an empty plan rather than a broken one for a short sample', () => {
        const result = plan(requiredCandleCount() + 10);

        expect(result.folds).toEqual([]);
        expect(auditWalkForwardPlan(result, requiredCandleCount() + 10).clean).toBe(
            true,
        );
    });
});

describe('the audit is what catches a plan that leaks', () => {
    it('passes the plan it builds', () => {
        const result = plan();

        expect(auditWalkForwardPlan(result, CANDLES).findings).toEqual([]);
        expect(auditWalkForwardPlan(result, CANDLES).clean).toBe(true);
    });

    it('catches a test window that reaches back into training', () => {
        // The one walk-forward exists to prevent. A `<` that became a `<=`
        // looks like nothing in a diff and adds a bar of the answer to every
        // fold.
        const result = plan();
        const broken: WalkForwardPlan = {
            ...result,
            folds: result.folds.map((fold, index) =>
                index === 0
                    ? {
                          ...fold,
                          test: {
                              startIndex: fold.train.endIndex,
                              endIndex: fold.test.endIndex,
                          },
                      }
                    : fold,
            ),
        };

        const audit = auditWalkForwardPlan(broken, CANDLES);

        expect(audit.clean).toBe(false);
        expect(audit.findings.map((finding) => finding.kind)).toContain(
            'test_overlaps_training',
        );
    });

    it('catches a window that reaches into the warm-up prefix', () => {
        const result = plan();
        const broken: WalkForwardPlan = {
            ...result,
            folds: result.folds.map((fold) => ({
                ...fold,
                train: { ...fold.train, startIndex: 10 },
            })),
        };

        expect(
            auditWalkForwardPlan(broken, CANDLES).findings.map((f) => f.kind),
        ).toContain('window_in_warmup');
    });

    it('catches a window that runs past the data that exists', () => {
        const result = plan();
        const broken: WalkForwardPlan = {
            ...result,
            folds: result.folds.map((fold) => ({
                ...fold,
                test: { ...fold.test, endIndex: CANDLES + 10 },
            })),
        };

        expect(
            auditWalkForwardPlan(broken, CANDLES).findings.map((f) => f.kind),
        ).toContain('window_past_data');
    });

    it('names the fold and the bars, not just that something was wrong', () => {
        const result = plan();
        const broken: WalkForwardPlan = {
            ...result,
            folds: result.folds.map((fold) => ({
                ...fold,
                test: { startIndex: fold.train.startIndex, endIndex: fold.test.endIndex },
            })),
        };

        const finding = auditWalkForwardPlan(broken, CANDLES).findings[0];

        // A finding a reader cannot act on is a finding nobody acts on.
        expect(finding?.detail).toMatch(/\d+\.\.\d+/);
        expect(finding?.fold).toBeGreaterThan(0);
    });

    it('stays clean for any fold geometry the options can produce', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 20, max: 400 }),
                fc.integer({ min: 20, max: 600 }),
                fc.integer({ min: 1, max: 12 }),
                (foldBars, trainingBars, maxFolds) => {
                    const result = plan(CANDLES, { foldBars, trainingBars, maxFolds });

                    // Every geometry the options allow has to survive its own
                    // audit. A guard that only holds for the shipped settings
                    // is a guard for the shipped settings.
                    expect(
                        auditWalkForwardPlan(result, CANDLES).findings,
                    ).toEqual([]);
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('validation rejects a fold without hiding it', () => {
    const [fold] = plan().folds;

    it('keeps a pair that held up', () => {
        const verdict = judgeFold(fold!, 0.002, 0.0015);

        expect(verdict.accepted).toBe(true);
        expect(verdict.reason).toMatch(/не хуже/);
    });

    it('drops a pair whose edge did not survive the next bar', () => {
        const verdict = judgeFold(fold!, 0.01, 0.0001);

        // The signature of having fitted the noise of the training window: it
        // looks excellent right up to the end of the bars it was chosen on.
        expect(verdict.accepted).toBe(false);
        expect(verdict.reason).toMatch(/по шуму/);
    });

    it('does not drop a pair for losing a little, which may still be the best', () => {
        // Rejecting a slightly-negative validation would leave the run with
        // nothing to trade, and the thing being rejected might be the best of
        // the available options. The default tolerance is one round trip of
        // cost rather than zero for exactly this reason.
        expect(judgeFold(fold!, 0.01, 0.009, 0.005).accepted).toBe(true);
        expect(judgeFold(fold!, 0.002, 0.0015).accepted).toBe(true);
    });

    it('keeps a pair that gave up less than the trade would have cost', () => {
        const verdict = judgeFold(fold!, 0.004, 0.0025);

        expect(DEFAULT_VALIDATION_TOLERANCE).toBeCloseTo(0.002, 10);
        expect(verdict.accepted).toBe(true);
    });

    it('drops a pair that gave up more than that, even while it still made money', () => {
        // Positive on both windows, and still rejected: a pair that earns 4% on
        // the bars it was chosen on and 1% on the next ones has an edge that
        // is mostly the training window.
        const verdict = judgeFold(fold!, 0.04, 0.01);

        expect(verdict.accepted).toBe(false);
    });

    it('says plainly that it could not measure', () => {
        expect(judgeFold(fold!, null, 0.001).accepted).toBe(false);
        expect(judgeFold(fold!, 0.001, null).reason).toMatch(/не измерено/);
    });
});
