import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { byRegime } from './regime-performance.js';
import { computeMetrics } from './performance.js';
import { PerformanceConfigParser } from './performance.config.js';

import type { PerformanceSample } from './performance.js';

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

const CONFIG = PerformanceConfigParser.parse({
    minimumSample: 5,
    confidenceEdges: [0, 25, 40, 55, 70, 85, 100],
    reportUnsampledAsNull: true,
});

function rows(
    count: number,
    regime: string | null,
    rate: number,
    start = 0,
): PerformanceSample[] {
    return Array.from({ length: count }, (_, index) => {
        const right = index < Math.round(count * rate);

        return {
            symbol: 'BTCUSDT',
            timestamp: BASE + (start + index) * HOUR,
            direction: 'LONG',
            verdict: right ? 'correct' : 'incorrect',
            returnFraction: right ? 0.02 : -0.02,
            confidence: 60,
            regime,
        };
    });
}

describe('a regime with no sample is not a regime with a bad score', () => {
    it('keeps an undersampled regime visible but out of the ranking', () => {
        const result = byRegime(
            [
                ...rows(20, 'NORMAL/TREND_UP', 0.8),
                ...rows(4, 'HIGH/RANGE', 0),
            ],
            CONFIG,
        );

        // Present with its count and no rate, so an operator can see that the
        // regime exists and that four signals is all there is — rather than
        // finding it silently missing.
        expect(result.byRegime.get('HIGH/RANGE')?.metrics.total).toBe(4);
        expect(result.byRegime.get('HIGH/RANGE')?.metrics.accuracy).toBeNull();

        // And out of the ranking, because a null can never be ranked as if it
        // were a score. A regime with four signals does not get to be called
        // the worst.
        expect(result.strongest).toBe('NORMAL/TREND_UP');
        expect(result.weakest).toBe('NORMAL/TREND_UP');
        expect(result.spread).toBeNull();
    });

    it('says how much of the sample carried no regime at all', () => {
        const result = byRegime(
            [...rows(20, 'NORMAL/TREND_UP', 0.8), ...rows(10, null, 0.5)],
            CONFIG,
        );

        // A table built over sixty percent of its own rows and presented as a
        // whole has a denominator nobody assumed.
        expect(result.unlabelled).toBe(10);
    });
});

describe('the spread is the finding, not the mean', () => {
    it('names the same system as two different numbers', () => {
        const result = byRegime(
            [...rows(50, 'NORMAL/TREND_UP', 0.9), ...rows(50, 'HIGH/RANGE', 0.3)],
            CONFIG,
        );

        const overall = computeMetrics(
            [...rows(50, 'NORMAL/TREND_UP', 0.9), ...rows(50, 'HIGH/RANGE', 0.3)],
            CONFIG,
        );

        // Sixty percent overall describes neither market. A trend detector and
        // a signal generator that only works in ranges are one number here and
        // opposite facts in the market.
        expect(overall.accuracy).toBeCloseTo(0.6, 10);
        expect(result.strongest).toBe('NORMAL/TREND_UP');
        expect(result.weakest).toBe('HIGH/RANGE');
        expect(result.spread).toBeCloseTo(0.6, 10);
    });

    it('measures each regime against the whole rather than against zero', () => {
        const result = byRegime(
            [...rows(40, 'NORMAL/TREND_UP', 0.8), ...rows(40, 'HIGH/RANGE', 0.4)],
            CONFIG,
        );

        // Overall is 0.6, so a regime at 0.8 sits 0.2 above it rather than at
        // 0.8 — the number a reader comparing regimes to each other wants.
        expect(result.byRegime.get('NORMAL/TREND_UP')?.lift).toBeCloseTo(0.2, 10);
        expect(result.byRegime.get('HIGH/RANGE')?.lift).toBeCloseTo(-0.2, 10);
    });

    it('leaves the lift out when the whole is below the floor', () => {
        const result = byRegime(rows(4, 'NORMAL/TREND_UP', 1), CONFIG);

        // A lift measured against an unmeasured whole is a number about the
        // regime, and it is exactly the regime nobody is looking at.
        expect(result.byRegime.get('NORMAL/TREND_UP')?.lift).toBeNull();
    });

    it('needs two measured regimes before it will name a best and a worst', () => {
        const one = byRegime(rows(20, 'NORMAL/TREND_UP', 0.7), CONFIG);

        expect(one.strongest).toBe('NORMAL/TREND_UP');
        expect(one.spread).toBeNull();
    });
});

describe('the breakdown always adds up to the sample it came from', () => {
    it('accounts for every signal', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.constantFrom(
                        'NORMAL/TREND_UP',
                        'HIGH/RANGE',
                        'LOW_VOL/RANGE',
                        null,
                    ),
                    { minLength: 1, maxLength: 60 },
                ),
                (regimes) => {
                    const result = byRegime(
                        regimes.map((regime, index) => ({
                            symbol: 'BTCUSDT',
                            timestamp: BASE + index * HOUR,
                            direction: 'LONG' as const,
                            verdict: 'correct' as const,
                            returnFraction: 0.02,
                            confidence: 60,
                            regime,
                        })),
                        CONFIG,
                    );

                    const grouped = [...result.byRegime.values()].reduce(
                        (sum, entry) => sum + entry.metrics.total,
                        0,
                    );

                    // The parts of the table have to add up to the sample. A
                    // breakdown that does not has a bug in how the groups are
                    // formed, and no individual number shows it.
                    expect(grouped + result.unlabelled).toBe(regimes.length);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never reports a spread outside the range of its own regimes', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        regime: fc.constantFrom('A', 'B', 'C'),
                        rate: fc.integer({ min: 0, max: 10 }),
                    }),
                    { minLength: 20, maxLength: 80 },
                ),
                (plan) => {
                    const samples: PerformanceSample[] = [];
                    let cursor = 0;

                    for (const entry of plan) {
                        samples.push(
                            ...rows(Math.max(5, entry.rate), entry.regime, entry.rate / 10, cursor),
                        );
                        cursor += Math.max(5, entry.rate);
                    }

                    const result = byRegime(samples, CONFIG);

                    if (result.spread !== null) {
                        // A difference of two accuracies cannot leave the unit
                        // interval. Anything else means a rate was compared
                        // against something that is not a rate.
                        expect(result.spread).toBeGreaterThanOrEqual(0);
                        expect(result.spread).toBeLessThanOrEqual(1);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});
