import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import {
    atrSeries,
    breakoutStrength,
    emaSeries,
    isReady,
    latest,
    priorRolling,
    rollingMax,
    rollingMin,
    rsiSeries,
    smaSeries,
} from './series.js';

/**
 * Properties, not examples.
 *
 * Everything below the fold in this file is a claim that has to hold for every
 * series anyone ever runs, not for the three that a hand-written fixture
 * happens to contain. The series helpers are the one piece of arithmetic that
 * every strategy in the project depends on and that no one reads: a rule
 * quietly wrong in `rollingMax` shows up as a strategy that does not work, and
 * the number of ways to be quietly wrong there is large.
 *
 * The claims that matter most are the ones that would leak. `priorRolling` is
 * the reason a breakout can be computed on a bar without seeing that bar's own
 * close, and it is a two-line function that is easy to get subtly wrong in a
 * way an example test will happily pass.
 */

const price = (max = 100_000): fc.Arbitrary<number> =>
    fc.double({ min: 0.01, max, noNaN: true, noDefaultInfinity: true });

const candles = (count: number): Candle[] =>
    Array.from({ length: count }, (_, index) => ({
        timestamp: 1_500_000_000_000 + index * 3_600_000,
        open: 100 + index,
        high: 102 + index,
        low: 98 + index,
        close: 101 + index,
        volume: 1,
    }));

const candleArrays = fc.array(candleArbitrary(), { minLength: 1, maxLength: 120 });

function candleArbitrary(): fc.Arbitrary<Candle> {
    return fc
        .tuple(price(1_000), price(1_000), price(1_000), price(1_000))
        .map(([open, close, high, low]) => {
            const top = Math.max(high, open, close);
            const bottom = Math.min(low, open, close);

            return {
                timestamp: 0,
                open,
                high: top,
                low: bottom,
                close,
                volume: 1,
            };
        });
}

describe('a rolling window looks backwards and only backwards', () => {
    it('rollingMax never returns a value smaller than anything in its window', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 1, maxLength: 80 }),
                fc.integer({ min: 1, max: 20 }),
                fc.nat(),
                (values, period, index) => {
                    const bounded = Math.min(index, values.length - 1);
                    const result = rollingMax(values, period)[bounded]!;

                    const window = values.slice(
                        Math.max(0, bounded - period + 1),
                        bounded + 1,
                    );

                    expect(result).toBeGreaterThanOrEqual(Math.max(...window));
                },
            ),
            { numRuns: 200 },
        );
    });

    it('rollingMin is the mirror of it', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 1, maxLength: 80 }),
                fc.integer({ min: 1, max: 20 }),
                fc.nat(),
                (values, period, index) => {
                    const bounded = Math.min(index, values.length - 1);
                    const window = values.slice(
                        Math.max(0, bounded - period + 1),
                        bounded + 1,
                    );

                    expect(rollingMin(values, period)[bounded]!).toBeLessThanOrEqual(
                        Math.min(...window),
                    );
                },
            ),
            { numRuns: 200 },
        );
    });

    it('the two can never cross', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 1, maxLength: 80 }),
                fc.integer({ min: 1, max: 20 }),
                (values, period) => {
                    const high = rollingMax(values, period);
                    const low = rollingMin(values, period);

                    for (let index = 0; index < values.length; index += 1) {
                        if (!Number.isNaN(high[index]!) && !Number.isNaN(low[index]!)) {
                            expect(low[index]!).toBeLessThanOrEqual(high[index]!);
                        }
                    }
                },
            ),
            { numRuns: 150 },
        );
    });
});

describe('priorRolling cannot see the bar it is about', () => {
    it('ignores the current value, so the newest bar cannot raise its own channel', () => {
        // This is the whole point of the function. A channel that includes the
        // bar being tested can never be broken by that bar, and a strategy using
        // it silently stops trading — which reads as a result, not a bug.
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 2, maxLength: 60 }),
                fc.integer({ min: 2, max: 10 }),
                (values, period) => {
                    const original = priorRolling(values, period, 'max');

                    // Change only the last value, to something enormous.
                    const tampered = [...values];
                    tampered[tampered.length - 1] = values[tampered.length - 1]! * 1000 + 1;
                    const after = priorRolling(tampered, period, 'max');

                    expect(after[after.length - 1]).toBe(original[original.length - 1]);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('still returns the value the window held one bar ago', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 2, maxLength: 60 }),
                fc.integer({ min: 1, max: 10 }),
                (values, period) => {
                    const at = Math.floor(values.length / 2);
                    const prior = priorRolling(values, period, 'max')[at];

                    if (prior === undefined || Number.isNaN(prior)) {
                        return;
                    }

                    // The prior channel at bar i is the plain channel at i-1,
                    // over exactly the same values.
                    const plain = rollingMax(values, period)[at - 1];

                    expect(prior).toBe(plain);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('leaves the first bar without a channel rather than inventing one', () => {
        fc.assert(
            fc.property(fc.array(price(), { minLength: 1, maxLength: 20 }), (values) => {
                const first = priorRolling(values, 5, 'max')[0];

                expect(Number.isNaN(first!)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });
});

describe('a moving average is not poisoned by one impossible bar', () => {
    it('recovers after a NaN instead of staying broken forever', () => {
        // The bug that cost this project a whole strategy: a NaN entered the
        // rolling window and never left it, so every downstream reading was
        // undefined and a strategy that measured zero trades looked like a
        // result rather than a fault.
        const values = Array.from({ length: 60 }, (_, index) => 100 + index);
        values[10] = Number.NaN;

        const series = smaSeries(values, 10);

        for (let index = 20; index < values.length; index += 1) {
            expect(Number.isNaN(series[index]!)).toBe(false);
        }
    });

    it('at the newest bar equals the mean of the last `period` good values', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 5, maxLength: 60 }),
                fc.integer({ min: 1, max: 10 }),
                (values, period) => {
                    const result = latest(smaSeries(values, period));

                    if (Number.isNaN(result)) {
                        return;
                    }

                    const window = values.slice(-period).filter((v) => !Number.isNaN(v));

                    expect(result).toBeCloseTo(
                        window.reduce((a, b) => a + b, 0) / window.length,
                        6,
                    );
                },
            ),
            { numRuns: 200 },
        );
    });

    it('agrees with the plain mean when no value is impossible', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 1, maxLength: 40 }),
                fc.integer({ min: 1, max: 8 }),
                (values, period) => {
                    // A window longer than the series has nothing to average.
                    // The first version of this test asserted a mean anyway and
                    // was handed NaN, which it reported as a failure in the
                    // helper rather than as a missing precondition here.
                    if (values.length < period) {
                        return;
                    }

                    const window = values.slice(-period);
                    const mean = window.reduce((a, b) => a + b, 0) / window.length;

                    expect(latest(smaSeries(values, period))).toBeCloseTo(mean, 6);
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('an exponential average starts somewhere and then moves', () => {
    it('at the newest bar is a number, whatever the series was', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 1, maxLength: 60 }),
                fc.integer({ min: 2, max: 30 }),
                (values, period) => {
                    const result = latest(emaSeries(values, period));

                    if (Number.isNaN(result)) {
                        return;
                    }

                    expect(Number.isFinite(result)).toBe(true);
                    expect(result).toBeGreaterThanOrEqual(Math.min(...values) - 1e-6);
                    expect(result).toBeLessThanOrEqual(Math.max(...values) + 1e-6);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('is inside the range of the series, not outside it', () => {
        // An EMA that overshoots on a step change is the classic symptom of the
        // first value being seeded with zero, which makes the first bar's
        // output meaningless and every bar after it slightly wrong.
        fc.assert(
            fc.property(
                fc.array(price(10), { minLength: 10, maxLength: 60 }),
                fc.integer({ min: 2, max: 20 }),
                (values, period) => {
                    const series = emaSeries(values, period);
                    const finite = series.filter((value) => !Number.isNaN(value));

                    for (const value of finite) {
                        expect(value).toBeGreaterThanOrEqual(Math.min(...values) - 1e-6);
                        expect(value).toBeLessThanOrEqual(Math.max(...values) + 1e-6);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('RSI is bounded, which is the only reason it is readable', () => {
    it('never leaves zero to one hundred', () => {
        fc.assert(
            fc.property(
                fc.array(price(), { minLength: 2, maxLength: 80 }),
                fc.integer({ min: 2, max: 21 }),
                (series, period) => {
                    for (const value of rsiSeries(series, period)) {
                        if (Number.isNaN(value)) {
                            continue;
                        }

                        expect(value).toBeGreaterThanOrEqual(0);
                        expect(value).toBeLessThanOrEqual(100);
                    }
                },
            ),
            { numRuns: 250 },
        );
    });

    it('reads 100 on a series that only ever rises and 0 on one that only falls', () => {
        const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
        const falling = Array.from({ length: 40 }, (_, i) => 200 - i);

        expect(latest(rsiSeries(rising, 14))).toBeCloseTo(100, 6);
        expect(latest(rsiSeries(falling, 14))).toBeCloseTo(0, 6);
    });
});

describe('ATR is never negative and never a fantasy', () => {
    it('is at least zero for any bar', () => {
        fc.assert(
            fc.property(
                candleArrays,
                fc.integer({ min: 2, max: 20 }),
                (series, period) => {
                    for (const value of atrSeries(series, period)) {
                        if (Number.isNaN(value)) {
                            continue;
                        }

                        expect(value).toBeGreaterThanOrEqual(0);
                    }
                },
            ),
            { numRuns: 150 },
        );
    });

    it('is never larger than the widest true range in the series', () => {
        // A smoothed average cannot exceed its largest input, and one that does
        // is being fed a true range computed from the wrong pair of prices.
        //
        // The bound is the true range and not high minus low, and the
        // difference is the whole point of the measure: after a gap, the true
        // range counts the jump from the previous close, so it is legitimately
        // larger than the bar's own height. The first version of this property
        // used high minus low and reported a correct ATR as broken.
        fc.assert(
            fc.property(
                candleArrays,
                fc.integer({ min: 2, max: 20 }),
                (series, period) => {
                    const trueRanges = series.map((candle, index) => {
                        if (index === 0) {
                            return candle.high - candle.low;
                        }

                        const previous = series[index - 1]!;

                        return Math.max(
                            candle.high - candle.low,
                            Math.abs(candle.high - previous.close),
                            Math.abs(candle.low - previous.close),
                        );
                    });

                    const widest = Math.max(...trueRanges);

                    for (const value of atrSeries(series, period)) {
                        if (Number.isNaN(value)) {
                            continue;
                        }

                        expect(value).toBeLessThanOrEqual(widest + 1e-6);
                    }
                },
            ),
            { numRuns: 150 },
        );
    });
});

describe('readiness is a question with one answer', () => {
    it('says no when anything is missing or impossible, and yes when all four are there', () => {
        // `nil: NaN` rather than `nil: undefined` so the property covers the
        // case that actually happens in the running system: a helper that had
        // not warmed up returns NaN, not nothing.
        fc.assert(
            fc.property(
                fc.option(price(), { nil: Number.NaN }),
                fc.option(price(), { nil: Number.NaN }),
                fc.option(price(), { nil: Number.NaN }),
                fc.option(price(), { nil: Number.NaN }),
                (a, b, c, d) => {
                    const all: readonly number[] = [a, b, c, d];

                    expect(
                        isReady(a ?? undefined, b ?? undefined, c ?? undefined, d ?? undefined),
                    ).toBe(all.every((value) => !Number.isNaN(value)));
                },
            ),
            { numRuns: 200 },
        );
    });

    it('treats a NaN as not ready, which is the only reading that is safe', () => {
        expect(isReady(1, Number.NaN, 3, 4)).toBe(false);
        expect(isReady(1, 2, 3, 4)).toBe(true);
    });
});

describe('the strength of a breakout', () => {
    it('is zero at the level and grows with the distance past it', () => {
        fc.assert(
            fc.property(
                price(1_000),
                fc.double({ min: 1, max: 500, noNaN: true }),
                price(1_000),
                (level, distance, atr) => {
                    const at = breakoutStrength(level, level, atr);
                    const past = breakoutStrength(level + distance, level, atr);

                    expect(at).toBe(0);
                    expect(past).toBeGreaterThanOrEqual(at);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never claims to be certain', () => {
        // No breakout is certain, and a confidence of 100 on a rule that is
        // wrong a third of the time is a lie with a number attached.
        fc.assert(
            fc.property(
                price(1_000),
                fc.double({ min: 0.0001, max: 1e12, noNaN: true }),
                price(1_000),
                (level, distance, atr) => {
                    const strength = breakoutStrength(level + distance, level, atr);

                    expect(strength).toBeGreaterThanOrEqual(0);
                    expect(strength).toBeLessThan(1);
                },
            ),
            { numRuns: 250 },
        );
    });

    it('refuses to divide by a range that is not there', () => {
        // The first bar of a series has no ATR, and dividing by zero there
        // produces Infinity, which flows into a published confidence.
        expect(breakoutStrength(110, 100, 0)).toBe(0);
        expect(breakoutStrength(110, 100, Number.NaN)).toBe(0);
        expect(breakoutStrength(110, 0, 10)).toBe(0);
        expect(breakoutStrength(Number.NaN, 100, 10)).toBe(0);
    });

    it('measures a short break against the lower level, not the upper one', () => {
        // Symmetry, and the copy-paste slip this replaced scored every short
        // against a level it had nothing to do with.
        const long = breakoutStrength(110, 100, 10);
        const short = breakoutStrength(90, 100, 10);

        expect(long).toBeCloseTo(short, 10);
    });
});

describe('a helper is asked the same question twice and must not change its mind', () => {
    it('is pure', () => {
        fc.assert(
            fc.property(candleArrays, (series) => {
                const before = atrSeries(series, 14);
                const after = atrSeries(series, 14);

                expect(after).toEqual(before);
            }),
            { numRuns: 100 },
        );
    });

    it('does not modify the series it was given', () => {
        fc.assert(
            fc.property(fc.array(price(), { minLength: 2, maxLength: 50 }), (values) => {
                const copy = [...values];

                rollingMax(values, 5);
                rollingMin(values, 5);
                priorRolling(values, 5, 'max');
                smaSeries(values, 5);
                emaSeries(values, 5);
                rsiSeries(values, 5);

                expect(values).toEqual(copy);
            }),
            { numRuns: 150 },
        );
    });
});

describe('a realistic series behaves', () => {
    it('produces a ready channel with a finite range on rising prices', () => {
        const series = candles(120);
        const highs = series.map((candle) => candle.high);

        expect(isReady(latest(rollingMax(highs, 20)), latest(rollingMin(highs, 20)))).toBe(
            true,
        );
    });
});
