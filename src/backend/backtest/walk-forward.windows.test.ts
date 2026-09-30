import { describe, expect, it } from 'vitest';

import { runWalkForward } from './walk-forward.js';
import { auditWalkForwardPlan } from './walk-forward.plan.js';
import { requiredCandleCount } from '../config/indicator.config.js';

import type { Candle } from '../types/market.js';
import type { WalkForwardPlan } from './walk-forward.plan.js';

const HOUR_MS = 3_600_000;
const WARMUP = requiredCandleCount();

function makeCandles(
    count: number,
    priceAt: (index: number) => number,
): Candle[] {
    const start = 1_700_000_000_000;

    return Array.from({ length: count }, (_, index) => {
        const price = priceAt(index);

        return {
            timestamp: start + index * HOUR_MS,
            open: price,
            high: price * 1.01,
            low: price * 0.99,
            close: price,
            volume: 1000,
        };
    });
}

/** A trending wave: enough swing for the stochastic to leave the middle. */
function marketCandles(count: number, amplitude = 0.12): Candle[] {
    return makeCandles(count, (index) => {
        const trend = 1 + index * 0.0004;
        const wave = 1 + amplitude * Math.sin((index / 18) * Math.PI * 2);

        return 100_000 * trend * wave;
    });
}

const SAMPLE = marketCandles(3000);

/**
 * The plan the run reported, wrapped so `auditWalkForwardPlan` can read it.
 *
 * Assembled from `fold.windows` — the windows the run carried out — rather than
 * from the arithmetic in the runner. Rebuilding the plan here would make the
 * assertion check its own inputs, which is the shape of oracle that reports a
 * clean run for a leaking one.
 */
function planOf(folds: readonly { windows: WalkForwardPlan['folds'][number] }[]): WalkForwardPlan {
    return {
        warmup: { startIndex: 0, endIndex: WARMUP - 1 },
        folds: folds.map((fold) => fold.windows),
        skippedFolds: 0,
    };
}

describe('the windows a walk-forward fold reports', () => {
    const result = runWalkForward(SAMPLE, { fitParameters: true });

    it('runs folds at all, or the checks below are vacuous', () => {
        // A guard against the empty-set property that made
        // `series.graph.test.ts` pass while asserting the opposite of its name.
        expect(result.folds.length).toBeGreaterThan(0);
    });

    it('passes the leakage audit on the windows it actually ran', () => {
        const audit = auditWalkForwardPlan(planOf(result.folds), SAMPLE.length);

        expect(audit.findings).toEqual([]);
        expect(audit.clean).toBe(true);
    });

    it('holds the fit and the validation window apart', () => {
        for (const fold of result.folds) {
            const { train, validate } = fold.windows;

            // Adjacent, not overlapping and not separated by a bar nobody used.
            expect(validate.startIndex).toBe(train.endIndex + 1);
            // The validation window is the tail of the training span, so it
            // cannot be longer than the span it was cut from.
            expect(validate.endIndex).toBeGreaterThanOrEqual(validate.startIndex);
        }
    });

    it('puts the test window after both, never inside the fit', () => {
        for (const fold of result.folds) {
            const { train, test } = fold.windows;

            expect(test.startIndex).toBeGreaterThan(train.endIndex);
            expect(test.startIndex).toBeGreaterThan(fold.windows.validate.endIndex);
        }
    });

    it('keeps every window clear of the warm-up prefix', () => {
        for (const fold of result.folds) {
            const { train, validate, test } = fold.windows;

            expect(train.startIndex).toBeGreaterThan(WARMUP - 1);
            expect(validate.startIndex).toBeGreaterThan(WARMUP - 1);
            expect(test.startIndex).toBeGreaterThan(WARMUP - 1);
        }
    });

    it('reports the same test window as the fold it belongs to', () => {
        // `startIndex`/`endIndex` predate `windows`; a run that computed one and
        // reported the other would pass every check above on `windows` alone.
        for (const fold of result.folds) {
            expect(fold.windows.test.startIndex).toBe(fold.startIndex);
            expect(fold.windows.test.endIndex).toBe(fold.endIndex);
        }
    });
});

describe('a run that fits nothing', () => {
    const result = runWalkForward(SAMPLE, { fitParameters: false });

    it('says so in the audit rather than inventing a validation window', () => {
        const audit = auditWalkForwardPlan(planOf(result.folds), SAMPLE.length);

        // The honest report is "this fold has no validation stage", not a
        // validate window that quietly covers the training span.
        expect(
            audit.findings.some((finding) => finding.kind === 'validation_misplaced'),
        ).toBe(true);
    });

    it('still reports accepted folds as unmeasured, not as passing', () => {
        for (const fold of result.folds) {
            expect(fold.validation.accepted).toBe(false);
            expect(fold.validation.validationScore).toBeNull();
        }
    });
});

describe('the audit is capable of failing', () => {
    // Without this, every assertion above would also hold if `auditWalkForwardPlan`
    // returned `{ findings: [], clean: true }` for any input at all.
    it('flags a plan whose validation window covers the training span', () => {
        const leaky: WalkForwardPlan = {
            warmup: { startIndex: 0, endIndex: WARMUP - 1 },
            folds: [
                {
                    fold: 1,
                    train: { startIndex: WARMUP, endIndex: WARMUP + 99 },
                    validate: { startIndex: WARMUP, endIndex: WARMUP + 99 },
                    test: { startIndex: WARMUP + 100, endIndex: WARMUP + 199 },
                },
            ],
            skippedFolds: 0,
        };

        const audit = auditWalkForwardPlan(leaky, 10_000);

        expect(audit.clean).toBe(false);
        expect(
            audit.findings.some((finding) => finding.kind === 'windows_overlap'),
        ).toBe(true);
    });
});
