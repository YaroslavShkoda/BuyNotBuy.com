import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PerformanceConfigParser } from './performance.config.js';
import type { PerformanceSample } from './performance.js';
import { byIndicator, combinationValue, computeMetrics } from './performance.js';

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

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
        indicators: [],
        ...overrides,
    };
}

describe('an indicator is measured on the signals it was on', () => {
    it('reports both the signals it agreed with and the ones it did not', () => {
        const rows = [
            ...Array.from({ length: 5 }, (_, index) =>
                sample(index, {
                    indicators: ['ema', 'rsi'],
                    verdict: 'correct',
                }),
            ),
            ...Array.from({ length: 5 }, (_, index) =>
                sample(5 + index, {
                    indicators: ['stochastic'],
                    verdict: 'incorrect',
                    returnFraction: -0.01,
                }),
            ),
        ];

        const table = byIndicator(rows, CONFIG);

        // An indicator table that only ever shows the signals it agreed with is
        // indistinguishable from one that shows the truth, and it is right
        // more often.
        expect(table.get('ema')?.withIndicator).toBe(5);
        expect(table.get('ema')?.withoutIndicator).toBe(5);
        expect(table.get('ema')?.metrics.accuracy).toBeCloseTo(1, 10);

        expect(table.get('stochastic')?.metrics.accuracy).toBeCloseTo(0, 10);
    });

    it('names every indicator in the sample, including one that never fired', () => {
        const table = byIndicator(
            [
                ...Array.from({ length: 5 }, (_, index) =>
                    sample(index, { indicators: ['ema'] }),
                ),
                sample(5, { indicators: ['rsi'], verdict: 'unknown' }),
            ],
            CONFIG,
        );

        // A silent indicator is the one an operator most needs to see: it is
        // absent from the table and looks identical to one that does not exist.
        expect([...table.keys()]).toEqual(['ema', 'rsi']);
        expect(table.get('rsi')?.withIndicator).toBe(1);
    });

    it('leaves the rate out when the indicator only has a handful of signals', () => {
        const table = byIndicator(
            [
                ...Array.from({ length: 30 }, (_, index) =>
                    sample(index, { indicators: ['ema'] }),
                ),
                sample(30, { indicators: ['rsi'], verdict: 'correct' }),
            ],
            CONFIG,
        );

        expect(table.get('rsi')?.withIndicator).toBe(1);
        expect(table.get('rsi')?.metrics.accuracy).toBeNull();
    });
});

describe('the added value of an indicator is a difference of two samples', () => {
    it('is null unless both sides are big enough to mean anything', () => {
        const table = combinationValue(
            [
                ...Array.from({ length: 30 }, (_, index) =>
                    sample(index, { indicators: ['ema'], verdict: 'correct' }),
                ),
                // Two signals where it was not pointing the same way. Enough
                // to look like evidence, not enough to be any.
                sample(30, { indicators: [], verdict: 'incorrect' }),
                sample(31, { indicators: [], verdict: 'incorrect' }),
            ],
            CONFIG,
        );

        // A lift computed from two signals and a lift computed from three
        // hundred are not the same number, and reporting both as a number is
        // how a table recommends an indicator on a coincidence.
        expect(table.get('ema')?.lift).toBeNull();
        expect(table.get('ema')?.metrics.accuracy).toBeCloseTo(1, 10);
    });

    it('is the difference when both sides are measured', () => {
        const table = combinationValue(
            [
                ...Array.from({ length: 10 }, (_, index) =>
                    sample(index, { indicators: ['ema'], verdict: 'correct' }),
                ),
                ...Array.from({ length: 10 }, (_, index) =>
                    sample(10 + index, {
                        indicators: [],
                        verdict: 'incorrect',
                        returnFraction: -0.01,
                    }),
                ),
            ],
            CONFIG,
        );

        expect(table.get('ema')?.lift).toBeCloseTo(1, 10);
    });

    it('is negative when the indicator was pointing the wrong way', () => {
        const table = combinationValue(
            [
                ...Array.from({ length: 10 }, (_, index) =>
                    sample(index, {
                        indicators: ['ema'],
                        verdict: 'incorrect',
                        returnFraction: -0.01,
                    }),
                ),
                ...Array.from({ length: 10 }, (_, index) =>
                    sample(10 + index, { indicators: [], verdict: 'correct' }),
                ),
            ],
            CONFIG,
        );

        // An indicator that costs accuracy when it agrees is still information,
        // and hiding the sign is how a table ends up recommending it.
        expect(table.get('ema')?.lift).toBeCloseTo(-1, 10);
    });
});

describe('an indicator table is a table and adds up', () => {
    it('assigns every signal to exactly one bucket per indicator', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.constantFrom('ema', 'rsi', 'macd', null),
                    { minLength: 1, maxLength: 40 },
                ),
                (indicators) => {
                    const table = byIndicator(
                        indicators.map((indicator, index) =>
                            sample(index, {
                                indicators: indicator === null ? [] : [indicator],
                            }),
                        ),
                        CONFIG,
                    );

                    for (const name of table.keys()) {
                        const entry = table.get(name);

                        // The sum has to be the whole sample. A table where it
                        // is not has a bug in how the buckets are formed, and
                        // the bug is invisible in every individual number.
                        expect(
                            (entry?.withIndicator ?? 0) +
                                (entry?.withoutIndicator ?? 0),
                        ).toBe(indicators.length);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never reports a lift outside the range the two accuracies allow', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        included: fc.boolean(),
                        verdict: fc.constantFrom('correct', 'incorrect', 'flat'),
                    }),
                    { minLength: 20, maxLength: 60 },
                ),
                (rows) => {
                    const table = combinationValue(
                        rows.map((row, index) =>
                            sample(index, {
                                indicators: row.included ? ['ema'] : [],
                                verdict: row.verdict,
                                returnFraction: row.verdict === 'correct' ? 0.02 : -0.01,
                            }),
                        ),
                        CONFIG,
                    );

                    const lift = table.get('ema')?.lift;

                    if (lift === null || lift === undefined) {
                        return;
                    }

                    // A difference of two numbers in [0, 1] cannot leave [0, 1].
                    // Anything else means a rate was compared against something
                    // that is not a rate.
                    expect(lift).toBeGreaterThanOrEqual(-1);
                    expect(lift).toBeLessThanOrEqual(1);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('agrees with the plain metrics for the signals it covers', () => {
        const rows = Array.from({ length: 12 }, (_, index) =>
            sample(index, { indicators: ['ema'] }),
        );

        expect(byIndicator(rows, CONFIG).get('ema')?.metrics).toEqual(
            computeMetrics(rows, CONFIG),
        );
    });
});
