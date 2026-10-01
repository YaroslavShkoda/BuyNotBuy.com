import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    computeMetrics,
    confidenceBuckets,
    groupBy,
    EMPTY_METRICS,
} from './performance.js';
import { PerformanceConfigParser } from './performance.config.js';

import type { PerformanceSample } from './performance.js';

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

/**
 * No floor, so the tests below are about the arithmetic rather than about
 * whether the sample was big enough. The floor has its own tests.
 */
const CONFIG = PerformanceConfigParser.parse({
    minimumSample: 5,
    confidenceEdges: [0, 25, 40, 55, 70, 85, 100],
    reportUnsampledAsNull: true,
});

function sample(
    index: number,
    overrides: Partial<PerformanceSample> = {},
): PerformanceSample {
    return {
        symbol: 'BTCUSDT',
        timestamp: BASE + index * HOUR,
        direction: 'LONG',
        verdict: 'correct',
        returnFraction: 0.02,
        confidence: 60,
        ...overrides,
    };
}

function set(
    count: number,
    overrides: Partial<PerformanceSample> = {},
): PerformanceSample[] {
    return Array.from({ length: count }, (_, index) => sample(index, overrides));
}

describe('the metrics say what happened', () => {
    it('counts the verdicts without scoring the unresolved ones', () => {
        const metrics = computeMetrics(
            [
                ...set(3, { verdict: 'correct' }),
                ...set(2, { verdict: 'incorrect', returnFraction: -0.01 }),
                sample(5, { verdict: 'flat', returnFraction: 0 }),
                sample(6, { verdict: 'unknown', returnFraction: null }),
                sample(7, { verdict: 'expired', returnFraction: null }),
            ],
            CONFIG,
        );

        expect(metrics.correct).toBe(3);
        expect(metrics.incorrect).toBe(2);
        expect(metrics.flat).toBe(1);
        // Reported, not folded into the accuracy: a reader has to be able to
        // see that the sample is partial.
        expect(metrics.unresolved).toBe(2);
        expect(metrics.total).toBe(6);
        expect(metrics.accuracy).toBeCloseTo(0.5, 10);
    });

    it('averages the returns and not the verdicts', () => {
        const metrics = computeMetrics(
            [
                sample(0, { returnFraction: 0.10 }),
                sample(1, { returnFraction: 0.02 }),
                sample(2, { returnFraction: 0.03 }),
                sample(3, { returnFraction: 0.01 }),
                sample(4, { returnFraction: 0.04 }),
            ],
            CONFIG,
        );

        expect(metrics.expectancy).toBeCloseTo(0.04, 10);
    });

    it('leaves an unresolved return out of the average rather than reading it as zero', () => {
        const withUnresolved = computeMetrics(
            [
                ...set(5, { returnFraction: 0.04 }),
                sample(5, { verdict: 'unknown', returnFraction: null }),
            ],
            CONFIG,
        );
        const without = computeMetrics(set(5, { returnFraction: 0.04 }), CONFIG);

        // Averaging a null as zero would pull the expectancy towards a return
        // the market never produced, and it would do it in the direction that
        // makes the system look worse, which is at least an honest direction —
        // but it is still a number nobody measured.
        expect(withUnresolved.expectancy).toBe(without.expectancy);
    });

    it('reports no profit factor when nothing lost money', () => {
        const metrics = computeMetrics(
            set(5, { verdict: 'correct', returnFraction: 0.02 }),
            CONFIG,
        );

        // Infinity is the true value and is not reportable. A table that prints
        // it reads as a bug; a table that prints a large finite number reads as
        // a real ratio.
        expect(metrics.profitFactor).toBeNull();
    });

    it('reports a profit factor when there were losses to measure against', () => {
        const metrics = computeMetrics(
            [
                ...set(3, { returnFraction: 0.02 }),
                ...set(2, { verdict: 'incorrect', returnFraction: -0.01 }),
            ],
            CONFIG,
        );

        expect(metrics.profitFactor).toBeCloseTo(0.06 / 0.02, 10);
    });
});

describe('the drawdown is about order, so order is imposed', () => {
    it('measures the fall from a running peak', () => {
        const metrics = computeMetrics(
            [
                sample(0, { returnFraction: 0.10 }),
                sample(1, { returnFraction: 0.10 }),
                sample(2, { returnFraction: -0.15 }),
                sample(3, { returnFraction: 0.10 }),
                sample(4, { returnFraction: 0.10 }),
            ],
            CONFIG,
        );

        // Twenty percent of a running peak, not the sum of the losses.
        expect(metrics.maxDrawdown).toBeCloseTo(0.15, 10);
    });

    it('measures the same set the same way whatever order it arrives in', () => {
        const rows = [
            sample(0, { returnFraction: 0.10 }),
            sample(1, { returnFraction: -0.15 }),
            sample(2, { returnFraction: 0.20 }),
            sample(3, { returnFraction: 0.10 }),
            sample(4, { returnFraction: -0.05 }),
        ];

        const inOrder = computeMetrics(rows, CONFIG);
        const shuffled = computeMetrics([...rows].reverse(), CONFIG);

        // A caller that had to remember to sort before calling would eventually
        // forget, and the figure it got wrong is the one nobody sanity-checks.
        expect(shuffled.maxDrawdown).toBeCloseTo(inOrder.maxDrawdown ?? 0, 10);
    });

    it('reports a drawdown as a magnitude rather than a negative number', () => {
        const metrics = computeMetrics(
            [
                sample(0, { returnFraction: 0.10 }),
                sample(1, { returnFraction: -0.30 }),
                sample(2, { returnFraction: 0.10 }),
                sample(3, { returnFraction: 0.10 }),
                sample(4, { returnFraction: 0.10 }),
            ],
            CONFIG,
        );

        // A drawdown of minus thirty percent and one of thirty percent are the
        // same event, and only one of the two reads correctly.
        expect(metrics.maxDrawdown).toBeCloseTo(0.30, 10);
    });
});

describe('a small sample reports counts, not rates', () => {
    it('withholds every rate below the floor', () => {
        const metrics = computeMetrics(set(4), CONFIG);

        expect(metrics.undersampled).toBe(true);
        expect(metrics.accuracy).toBeNull();
        expect(metrics.expectancy).toBeNull();
        expect(metrics.maxDrawdown).toBeNull();
        // But still says what it has: four signals is a fact, a 100% hit rate
        // on four signals is not.
        expect(metrics.correct).toBe(4);
    });

    it('still adds up when it withholds the rates', () => {
        const metrics = computeMetrics(
            [...set(4, { verdict: 'incorrect', returnFraction: -0.01 })],
            CONFIG,
        );

        // A bucket that reports four incorrect signals and a total of zero
        // cannot be added up, and a table whose parts do not sum to its sample
        // cannot be checked by anyone reading it. Found by the property below.
        expect(metrics.total).toBe(4);
        expect(metrics.incorrect).toBe(4);
    });

    it('is empty rather than zero for an empty set', () => {
        expect(computeMetrics([], CONFIG)).toEqual(EMPTY_METRICS);
    });

    it('does not pretend a sample of unresolved signals was scored', () => {
        const metrics = computeMetrics(
            set(40, { verdict: 'unknown', returnFraction: null }),
            CONFIG,
        );

        // Forty rows that have not been resolved yet are not a sample of forty
        // losses, and counting them as one is how a table reports a 0% hit rate
        // for a system that has not been judged yet.
        expect(metrics.total).toBe(0);
        expect(metrics.unresolved).toBe(40);
        expect(metrics.accuracy).toBeNull();
    });
});

describe('the confidence buckets answer the uncomfortable question', () => {
    it('does not sort the buckets by how good they look', () => {
        const { buckets } = confidenceBuckets(
            [
                ...set(5, { confidence: 90, verdict: 'incorrect', returnFraction: -0.01 }),
                ...set(5, { confidence: 10, verdict: 'correct', returnFraction: 0.01 }),
            ],
            CONFIG,
        );

        // A table that reordered by rate would be reporting the shape of its
        // own sample as a property of the strategy.
        expect(buckets.map((bucket) => bucket.label)).toEqual([
            '0-25',
            '25-40',
            '40-55',
            '55-70',
            '70-85',
            '85-100',
        ]);
    });

    it('places a signal at exactly 100 in the last bucket', () => {
        const { buckets, unplaced } = confidenceBuckets(
            set(5, { confidence: 100 }),
            CONFIG,
        );

        // Without a closed upper edge on the last bucket, a signal published at
        // exactly 100 falls out of the table entirely.
        expect(buckets.at(-1)?.metrics.correct).toBe(5);
        expect(unplaced).toBe(0);
    });

    it('places a signal at exactly 0 in the first bucket', () => {
        const { buckets } = confidenceBuckets(set(5, { confidence: 0 }), CONFIG);

        expect(buckets[0]?.metrics.correct).toBe(5);
    });

    it('leaves an upper edge exclusive so no signal is counted twice', () => {
        const { buckets } = confidenceBuckets(
            [...set(5, { confidence: 24 }), ...set(5, { confidence: 25 })],
            CONFIG,
        );

        expect(buckets[0]?.metrics.correct).toBe(5);
        expect(buckets[1]?.metrics.correct).toBe(5);
    });

    it('refuses edges that would leave part of the range unmeasured', () => {
        expect(() =>
            PerformanceConfigParser.parse({
                minimumSample: 5,
                confidenceEdges: [10, 50, 100],
                reportUnsampledAsNull: true,
            }),
        ).toThrow(/start at 0/);

        expect(() =>
            PerformanceConfigParser.parse({
                minimumSample: 5,
                confidenceEdges: [0, 50, 90],
                reportUnsampledAsNull: true,
            }),
        ).toThrow(/end at 100/);

        expect(() =>
            PerformanceConfigParser.parse({
                minimumSample: 5,
                confidenceEdges: [0, 50, 50, 100],
                reportUnsampledAsNull: true,
            }),
        ).toThrow(/strictly ascending/);
    });
});

describe('grouping never invents a group', () => {
    it('leaves a signal with no regime out rather than filing it as null', () => {
        const groups = groupBy(
            [
                ...set(5, { regime: 'NORMAL/TREND_UP' }),
                ...set(5, { regime: null }),
            ],
            (row) => row.regime,
            CONFIG,
        );

        // A null bucket would sit next to a real regime in a chart looking like
        // a comparable sample, and claiming the system behaves one way when it
        // does not know what market it is in.
        expect([...groups.keys()]).toEqual(['NORMAL/TREND_UP']);
        expect(groups.get('NORMAL/TREND_UP')?.total).toBe(5);
    });

    it('counts an empty string as absent too', () => {
        const groups = groupBy(set(5, { regime: '' }), (row) => row.regime, CONFIG);

        expect(groups.size).toBe(0);
    });
});

describe('whatever the numbers are', () => {
    it('keeps the accuracy between zero and one for any sample', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        verdict: fc.constantFrom('correct', 'incorrect', 'flat'),
                        returnFraction: fc.double({
                            min: -1,
                            max: 1,
                            noNaN: true,
                            noDefaultInfinity: true,
                        }),
                    }),
                    { minLength: 5, maxLength: 60 },
                ),
                fc.nat(),
                (rows, offset) => {
                    const metrics = computeMetrics(
                        rows.map((row, index) => sample(index, {
                            ...row,
                            timestamp: BASE + (index + offset) * HOUR,
                        })),
                        CONFIG,
                    );

                    if (metrics.accuracy !== null) {
                        expect(metrics.accuracy).toBeGreaterThanOrEqual(0);
                        expect(metrics.accuracy).toBeLessThanOrEqual(1);
                    }

                    if (metrics.maxDrawdown !== null) {
                        // A drawdown is a distance between two points of an
                        // equity curve, so it cannot be negative no matter what
                        // the returns were.
                        expect(metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
                    }

                    if (metrics.directionAccuracy !== null) {
                        expect(metrics.directionAccuracy).toBeGreaterThanOrEqual(0);
                        expect(metrics.directionAccuracy).toBeLessThanOrEqual(1);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });

    it('counts every sample exactly once across the buckets', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.double({
                        min: 0,
                        max: 100,
                        noNaN: true,
                        noDefaultInfinity: true,
                    }),
                    { minLength: 1, maxLength: 40 },
                ),
                (confidences) => {
                    const { buckets, unplaced } = confidenceBuckets(
                        confidences.map((confidence, index) =>
                            sample(index, { confidence }),
                        ),
                        CONFIG,
                    );

                    const placed = buckets.reduce(
                        (sum, bucket) => sum + bucket.metrics.total,
                        0,
                    );

                    // The config already makes this zero by construction. It is
                    // asserted because a number that has to be zero by
                    // construction is a number that should be checked.
                    expect(placed + unplaced).toBe(confidences.length);
                },
            ),
            { numRuns: 200 },
        );
    });
});
