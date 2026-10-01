import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { calibrate, reliability, UNMEASURED } from './calibration.js';
import { PerformanceConfigParser } from './performance.config.js';

import type { PerformanceSample } from './performance.js';

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

const CONFIG = PerformanceConfigParser.parse({
    minimumSample: 5,
    confidenceEdges: [0, 40, 70, 100],
    reportUnsampledAsNull: true,
});

/**
 * A signal the system was right about, published at `claimed` confidence.
 *
 * Built as a generator rather than as a literal list so the two halves of the
 * test can be moved apart: the claimed confidence and what actually happened
 * are independent inputs, and a fixture where they always agree cannot test a
 * thing whose entire purpose is to measure the disagreement.
 */
function outcome(
    index: number,
    claimed: number,
    wasRight: boolean,
    overrides: Partial<PerformanceSample> = {},
): PerformanceSample {
    return {
        symbol: 'BTCUSDT',
        timestamp: BASE + index * HOUR,
        direction: 'LONG',
        verdict: wasRight ? 'correct' : 'incorrect',
        returnFraction: wasRight ? 0.02 : -0.02,
        confidence: claimed,
        ...overrides,
    };
}

/** A sample where the system is right `rate` of the time at `claimed`. */
function sample(
    count: number,
    claimed: number,
    rate: number,
    start = 0,
): PerformanceSample[] {
    return Array.from({ length: count }, (_, index) =>
        outcome(start + index, claimed, index < Math.round(count * rate)),
    );
}

describe('calibration is the gap between what was claimed and what happened', () => {
    it('is unmeasured for a sample with nothing in it', () => {
        expect(calibrate([], CONFIG)).toEqual(UNMEASURED);
    });

    it('reports a gap of zero for a system that is right as often as it says', () => {
        // Claimed 85% and right 85% of the time. The whole claim of the
        // exercise is that this is checkable rather than assumed.
        const rows: PerformanceSample[] = Array.from({ length: 100 }, (_, index) =>
            outcome(index, 85, index % 20 < 17),
        );

        const result = calibrate(rows, CONFIG);

        expect(result.meanClaimed).toBeCloseTo(0.85, 10);
        expect(result.meanActual).toBeCloseTo(0.85, 10);
        expect(result.score).toBeCloseTo(1, 1);
    });

    it('sees a system that is right more often than it claims', () => {
        const rows: PerformanceSample[] = Array.from({ length: 100 }, (_, index) =>
            outcome(index, 40, index % 10 < 9),
        );

        const result = calibrate(rows, CONFIG);

        // Positive means too cautious, negative means it promised more than it
        // delivered. The sign is the whole content of the number.
        expect(result.meanActual ?? 0).toBeGreaterThan(result.meanClaimed ?? 0);
        expect(result.score ?? 1).toBeLessThan(1);
    });

    it('points at the bucket that is wrong rather than averaging it away', () => {
        const rows: PerformanceSample[] = [
            ...sample(20, 20, 0.8, 0),
            // Perfectly calibrated elsewhere, and badly wrong here. An average
            // of the gaps would barely move.
            ...Array.from({ length: 20 }, (_, index) =>
                outcome(20 + index, 85, index % 2 === 0),
            ),
        ];

        const result = calibrate(rows, CONFIG);
        const top = result.points.at(-1);
        const cautious = result.points[0];

        // Claimed at the 70-100 midpoint of 85, actually right half the time.
        expect(top?.gap ?? 0).toBeCloseTo(0.5 - 0.85, 10);

        // The worst gap is the largest *deviation*, in either direction. Here
        // that is the bucket that claimed 20 and delivered 80: promising less
        // than it delivers is a calibration failure just as much as promising
        // more, and a layer that only reported overconfidence would send
        // somebody off to fix the wrong thing.
        expect(cautious?.gap ?? 0).toBeCloseTo(0.8 - 0.2, 10);
        expect(result.worstGap).toBeCloseTo(cautious?.gap ?? 0, 10);
    });

    it('keeps an empty bucket on the curve with a null on it', () => {
        const rows: PerformanceSample[] = sample(20, 85, 0.85);

        const result = calibrate(rows, CONFIG);
        const empty = result.points.find((point) => point.claimed === 0.2);

        // The shape of the curve is the finding. Dropping the empty buckets
        // would draw a line straight through the gap and make an unmeasured
        // range look like a good one.
        expect(empty).toBeDefined();
        expect(empty?.actual).toBeNull();
        expect(empty?.total).toBe(0);
    });

    it('cannot claim it is calibrated from a handful of signals', () => {
        const result = calibrate(sample(3, 85, 1), CONFIG);

        expect(result.unmeasured).toBe(true);
        expect(result.score).toBeNull();
    });
});

describe('the score is a weighted gap, not a mean of buckets', () => {
    it('is decided by the buckets with the most signals in them', () => {
        // One huge bucket barely wrong, one tiny bucket wildly wrong. An
        // unweighted mean of buckets would call these the same, and would let
        // twenty signals set the score of two hundred.
        const mostlyFine: PerformanceSample[] = [
            ...sample(200, 20, 0.25, 0),
            // Claims 85, delivers 20. A gap of 0.65 over twenty signals.
            ...sample(20, 85, 0.2, 200),
        ];
        const mostlyWrong: PerformanceSample[] = [
            ...sample(20, 20, 0.25, 0),
            ...sample(200, 85, 0.2, 20),
        ];

        const whenTheManyAreRoughlyRight = calibrate(mostlyFine, CONFIG);
        const whenTheManyAreWildlyWrong = calibrate(mostlyWrong, CONFIG);

        // The 20-bucket claims 20% and delivers 25%: a gap of 0.05. The 85
        // bucket claims 85% and delivers 20%: a gap of 0.65. The answer must
        // depend on which of those carries the sample.
        expect(whenTheManyAreRoughlyRight.score ?? 0).toBeGreaterThan(
            whenTheManyAreWildlyWrong.score ?? 0,
        );
    });

    it('stays inside the unit interval for any sample at all', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        confidence: fc.integer({ min: 0, max: 100 }),
                        correct: fc.boolean(),
                    }),
                    { minLength: 1, maxLength: 80 },
                ),
                (rows) => {
                    const result = calibrate(
                        rows.map((row, index) =>
                            outcome(index, row.confidence, row.correct),
                        ),
                        CONFIG,
                    );

                    if (result.score === null) {
                        return;
                    }

                    // A weighted mean absolute gap between two rates in [0, 1]
                    // is in [0, 1] by construction. Anything outside it means
                    // one of the two was not a rate.
                    expect(result.score).toBeGreaterThanOrEqual(0);
                    expect(result.score).toBeLessThanOrEqual(1);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('keeps every gap between minus one and one', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        confidence: fc.integer({ min: 0, max: 100 }),
                        correct: fc.boolean(),
                    }),
                    { minLength: 5, maxLength: 60 },
                ),
                (rows) => {
                    const result = calibrate(
                        rows.map((row, index) =>
                            outcome(index, row.confidence, row.correct),
                        ),
                        CONFIG,
                    );

                    for (const point of result.points) {
                        if (point.gap !== null) {
                            expect(point.gap).toBeGreaterThanOrEqual(-1);
                            expect(point.gap).toBeLessThanOrEqual(1);
                        }

                        expect(point.actual ?? 0).toBeGreaterThanOrEqual(0);
                        expect(point.actual ?? 0).toBeLessThanOrEqual(1);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('reliability is about now, not about the average', () => {
    it('says nothing when there is not enough history', () => {
        const result = reliability(sample(10, 70, 0.7), CONFIG);

        // "No change" and "not enough to tell" are different sentences, and
        // the second is the true one about a system with ten signals.
        expect(result.verdict).toBe('unmeasured');
        expect(result.drift).toBeNull();
    });

    it('calls a system that has quietly stopped working what it is', () => {
        const rows = [
            ...sample(200, 70, 0.85, 0),
            ...sample(50, 70, 0.2, 200),
        ];

        const result = reliability(rows, CONFIG, { recent: 50, tolerance: 0.1 });

        expect(result.verdict).toBe('degrading');
        expect(result.drift ?? 0).toBeLessThan(-0.5);
    });

    it('calls a system that has started working again what it is too', () => {
        // Reported, not celebrated. A reliability layer that only has good news
        // to say is one that will be believed when it has bad news.
        const rows = [
            ...sample(200, 70, 0.2, 0),
            ...sample(50, 70, 0.85, 200),
        ];

        const result = reliability(rows, CONFIG, { recent: 50, tolerance: 0.1 });

        expect(result.verdict).toBe('improving');
    });

    it('does not call ordinary noise a change', () => {
        const rows = [
            ...sample(200, 70, 0.7, 0),
            ...sample(100, 70, 0.73, 200),
        ];

        const result = reliability(rows, CONFIG, { recent: 100, tolerance: 0.1 });

        expect(result.verdict).toBe('stable');
    });

    it('measures the recent window by time rather than by arrival', () => {
        const rows = [
            // Arrived in the worst possible order: the recent fifty first.
            ...sample(50, 70, 0.1, 200),
            ...sample(200, 70, 0.9, 0),
        ];

        const result = reliability(rows, CONFIG, { recent: 50, tolerance: 0.1 });

        // Order of arrival is an accident of how the poller ran, and a
        // reliability number built on it is a number about the poller.
        expect(result.verdict).toBe('degrading');
    });

    it('does not let a recent run hide inside the average it is compared to', () => {
        // A recent collapse inside an otherwise good history. Comparing the
        // recent window to the overall mean would report almost no drift,
        // because the mean is mostly the part that was fine.
        const rows = [
            ...sample(400, 70, 0.9, 0),
            ...sample(100, 70, 0.1, 400),
        ];

        const result = reliability(rows, CONFIG, { recent: 100, tolerance: 0.1 });

        expect(result.verdict).toBe('degrading');
        expect(result.drift ?? 0).toBeLessThan(-0.5);
    });
});
