import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { findCandleSeriesIssues } from '../market/candle-validation.js';
import { decodeCursor, encodeCursor } from '../api/lib/history-cursor.js';
import { calculateMetrics } from '../backtest/metrics.js';

import type { Candle } from '../types/market.js';
import type { Trade } from '../backtest/metrics.js';

/**
 * Properties, not examples.
 *
 * Every other suite in this repository pins down a handful of chosen inputs,
 * which is the right way to describe what a function is meant to do and the
 * wrong way to find the input nobody thought of. These tests state the rule and
 * let the generator pick the inputs, so a violation anywhere in the space shows
 * up as a reproducible counterexample rather than as a bug report.
 */

const HOUR = 3_600_000;
const ORIGIN = 1_700_000_000_000;

// The floor is 1000 so that a deliberately broken high stays positive: a broken
// high below zero would be caught as a negative price instead, and the test
// would pass without ever reaching the check it exists for.
const price = fc.double({ min: 1000, max: 1_000_000, noNaN: true, noDefaultInfinity: true });
const timestamp = fc.integer({ min: 0, max: 2_000_000_000_000 });

/** A series that satisfies every invariant the validator checks. */
const wellFormedSeries = fc
    .array(
        fc.record({
            open: price,
            close: price,
            high: price,
            low: price,
            volume: fc.double({ min: 0, max: 1e9, noNaN: true }),
        }),
        { minLength: 1, maxLength: 40 },
    )
    .map((rows) => {
        let previous = ORIGIN;

        return rows.map((row, index) => {
            // The widest possible high/low so the generated row is never
            // rejected for an OHLC range it could not physically have.
            const high = Math.max(row.open, row.close, row.high, row.low);
            const low = Math.min(row.open, row.close, row.high, row.low);
            const at = previous;

            previous += HOUR * (index + 1);

            return {
                timestamp: at,
                open: row.open,
                high,
                low,
                close: row.close,
                volume: row.volume,
            } satisfies Candle;
        });
    });

describe('candle series validation', () => {
    it('accepts every well-formed series', () => {
        fc.assert(
            fc.property(wellFormedSeries, (candles) => {
                const last = candles[candles.length - 1];

                expect(
                    findCandleSeriesIssues(candles, last?.timestamp ?? 0, 1000),
                ).toBeNull();
            }),
            { numRuns: 200 },
        );
    });

    it('rejects a series whose timestamps are not increasing', () => {
        fc.assert(
            fc.property(
                wellFormedSeries.filter((candles) => candles.length > 2),
                (candles) => {
                    const index = 1 + (candles.length % (candles.length - 2));
                    const swapped = [...candles];

                    [swapped[index], swapped[index - 1]] = [
                        swapped[index - 1] as Candle,
                        swapped[index] as Candle,
                    ];

                    // A swapped pair can coincidentally still be increasing when
                    // the original pair was one bar apart in a different order,
                    // so the assertion is that *something* is wrong, not that a
                    // specific issue is.
                    expect(
                        findCandleSeriesIssues(swapped, ORIGIN + HOUR * 1000, 1000),
                    ).not.toBeNull();
                },
            ),
            { numRuns: 150 },
        );
    });

    it('rejects a duplicate timestamp', () => {
        fc.assert(
            fc.property(
                wellFormedSeries.filter((candles) => candles.length > 1),
                (candles) => {
                    const duplicated = [...candles];

                    duplicated[1] = { ...candles[0] } as Candle;

                    expect(
                        findCandleSeriesIssues(duplicated, ORIGIN + HOUR * 1000, 1000),
                    ).toBe('duplicate');
                },
            ),
            { numRuns: 150 },
        );
    });

    it('rejects a candle whose high is below its low', () => {
        fc.assert(
            fc.property(
                wellFormedSeries,
                fc.integer({ min: 0, max: 39 }),
                (candles, rawIndex) => {
                    if (candles.length === 0) {
                        return;
                    }

                    const index = rawIndex % candles.length;
                    const broken = [...candles];
                    const candle = broken[index] as Candle;

                    // Halving the low rather than subtracting a gap: a
                    // subtraction large enough to matter can push the high
                    // below zero, and then the rejection would come from the
                    // negative-price check instead of the one under test.
                    broken[index] = { ...candle, high: candle.low / 2 };

                    expect(
                        findCandleSeriesIssues(broken, ORIGIN + HOUR * 1000, 1000),
                    ).toBe('ohlc_inconsistent');
                },
            ),
            { numRuns: 150 },
        );
    });

    it('rejects a negative price however small the magnitude', () => {
        fc.assert(
            fc.property(
                wellFormedSeries,
                fc.integer({ min: 0, max: 39 }),
                fc.double({ min: 0.0001, max: 1000, noNaN: true }),
                (candles, rawIndex, magnitude) => {
                    if (candles.length === 0) {
                        return;
                    }

                    const index = rawIndex % candles.length;
                    const broken = [...candles];
                    const candle = broken[index] as Candle;

                    broken[index] = {
                        ...candle,
                        open: -magnitude,
                        high: -magnitude,
                        low: -magnitude,
                        close: -magnitude,
                    };

                    // Every price is below zero and none of them is an
                    // ordering violation of the highs and lows, so the negative
                    // check is the only one that can fire.
                    expect(
                        findCandleSeriesIssues(broken, ORIGIN + HOUR * 1000, 1000),
                    ).toBe('negative');
                },
            ),
            { numRuns: 150 },
        );
    });

    it('rejects a candle dated after the moment of the check', () => {
        fc.assert(
            fc.property(
                wellFormedSeries,
                timestamp,
                (candles, now) => {
                    const broken = [...candles];
                    const index = broken.length - 1;
                    const candle = broken[index] as Candle;

                    broken[index] = { ...candle, timestamp: now + HOUR * 2 };

                    // The last candle is the one that moves; earlier ones are
                    // untouched and must not be the thing reported.
                    expect(
                        findCandleSeriesIssues(broken, now, 1000),
                    ).toBe('from_the_future');
                },
            ),
            { numRuns: 150 },
        );
    });
});

describe('history cursor', () => {
    it('round-trips any bucket', () => {
        fc.assert(
            fc.property(timestamp, (bucket) => {
                expect(decodeCursor(encodeCursor(bucket))).toBe(bucket);
            }),
            { numRuns: 500 },
        );
    });

    it('survives a cursor that crosses a base64url boundary', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
                (bucket) => {
                    expect(decodeCursor(encodeCursor(bucket))).toBe(bucket);
                },
            ),
            { numRuns: 500 },
        );
    });

    it('rejects a cursor with any single character changed', () => {
        fc.assert(
            fc.property(timestamp, fc.integer({ min: 0, max: 1000 }), (bucket, rawPosition) => {
                const cursor = encodeCursor(bucket);
                const position = rawPosition % cursor.length;
                const alphabet = 'ABCXYZabcxyz0189-_';
                const original = cursor[position] as string;
                const replacement =
                    alphabet[(alphabet.indexOf(original) + 1) % alphabet.length] as string;
                const tampered =
                    cursor.slice(0, position) + replacement + cursor.slice(position + 1);

                if (tampered === cursor) {
                    return;
                }

                // A signed cursor that accepted a modified value would let a
                // client ask for a page boundary the server never offered. The
                // one accepted outcome is a different spelling of the same
                // bucket: base64url has non-significant bits in its final
                // character, so one character can be edited without changing
                // the bytes it decodes to.
                const decoded = decodeCursor(tampered);

                expect(decoded === null || decoded === bucket).toBe(true);
            }),
            { numRuns: 400 },
        );
    });

    it('rejects a truncated cursor', () => {
        fc.assert(
            fc.property(timestamp, fc.integer({ min: 0, max: 20 }), (bucket, rawCut) => {
                const cursor = encodeCursor(bucket);
                const cut = rawCut % cursor.length;

                expect(decodeCursor(cursor.slice(0, cut))).toBeNull();
            }),
            { numRuns: 300 },
        );
    });

    it('rejects a cursor that is not base64url at all', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 40 }), (text) => {
                expect(decodeCursor(text)).toBeNull();
            }),
            { numRuns: 300 },
        );
    });
});

describe('backtest metrics', () => {
    const tradeArb = fc
        .array(
            fc.record({
                netReturn: fc.double({
                    min: -0.9,
                    max: 5,
                    noNaN: true,
                    noDefaultInfinity: true,
                }),
                grossReturn: fc.double({
                    min: -0.9,
                    max: 5,
                    noNaN: true,
                    noDefaultInfinity: true,
                }),
                direction: fc.constantFrom(1 as const, -1 as const),
            }),
        )
        .map(
            (rows) =>
                rows.map(
                    (row, index): Trade => ({
                        entryIndex: index * 2,
                        exitIndex: index * 2 + 1,
                        direction: row.direction,
                        entryPrice: 100 + index,
                        exitPrice: 100 + index + row.grossReturn,
                        netReturn: row.netReturn,
                        grossReturn: row.grossReturn,
                    }),
                ),
        );

    /** A list of trades, rather than a list of lists of trades. */
    const tradeListArb = (minLength: number, maxLength: number) =>
        fc
            .array(tradeArb, { minLength, maxLength })
            .map((lists) => lists.flat());

    it('accounts for every trade in the win rate', () => {
        fc.assert(
            fc.property(
                tradeListArb(1, 60),
                (trades) => {
                    const metrics = calculateMetrics(
                        trades,
                        trades.length,
                        { long: 0, short: 0, neutral: 0 },
                        365 * 24,
                    );

                    const wins = trades.filter((trade) => trade.netReturn > 0).length;
                    const losses = trades.filter((trade) => trade.netReturn < 0).length;

                    // A trade that returned exactly nothing is neither a win
                    // nor a loss, so the two counts may fall short of the
                    // total — but they can never exceed it, and the rate can
                    // never leave the unit interval.
                    expect(wins + losses).toBeLessThanOrEqual(trades.length);
                    expect(metrics.winRate).toBeGreaterThanOrEqual(0);
                    expect(metrics.winRate).toBeLessThanOrEqual(1);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('compounds rather than sums', () => {
        // Returns are bounded here. A chain of twenty 6x gains overflows to
        // infinity, and an assertion that cannot survive its own input is not
        // a rule about compounding.
        const bounded = fc.array(
            fc.double({ min: -0.5, max: 0.5, noNaN: true, noDefaultInfinity: true }),
            { minLength: 1, maxLength: 20 },
        );

        fc.assert(
            fc.property(bounded, (returns) => {
                const trades = returns.map(
                    (netReturn, index): Trade => ({
                        entryIndex: index * 2,
                        exitIndex: index * 2 + 1,
                        direction: 1,
                        entryPrice: 100,
                        exitPrice: 100 * (1 + netReturn),
                        netReturn,
                        grossReturn: netReturn,
                    }),
                );

                const metrics = calculateMetrics(
                    trades,
                    trades.length,
                    { long: 0, short: 0, neutral: 0 },
                    365 * 24,
                );

                const expected =
                    returns.reduce(
                        (product, value) => product * (1 + value),
                        1,
                    ) - 1;

                expect(metrics.totalReturn).toBeCloseTo(expected, 6);
            }),
            { numRuns: 200 },
        );
    });

    it('never reports a drawdown above one', () => {
        fc.assert(
            fc.property(
                tradeListArb(1, 40),
                (trades) => {
                    const metrics = calculateMetrics(
                        trades,
                        trades.length,
                        { long: 0, short: 0, neutral: 0 },
                        365 * 24,
                    );

                    expect(metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
                    expect(metrics.maxDrawdown).toBeLessThanOrEqual(1);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never invents a profit factor for a run with no losses', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.double({ min: 0.0001, max: 2, noNaN: true }),
                    { minLength: 1, maxLength: 20 },
                ),
                (returns) => {
                    const metrics = calculateMetrics(
                        returns.map(
                            (netReturn, index): Trade => ({
                                entryIndex: index * 2,
                                exitIndex: index * 2 + 1,
                                direction: 1,
                                entryPrice: 100,
                                exitPrice: 100 * (1 + netReturn),
                                netReturn,
                                grossReturn: netReturn,
                            }),
                        ),
                        returns.length,
                        { long: 0, short: 0, neutral: 0 },
                        365 * 24,
                    );

                    // Gross loss is zero here, so a finite ratio would be a
                    // division by nothing dressed up as a number.
                    expect(metrics.profitFactor).toBeNull();
                },
            ),
            { numRuns: 200 },
        );
    });

    it('gives the same answer for the same input', () => {
        fc.assert(
            fc.property(
                tradeListArb(1, 30),
                (trades) => {
                    const first = calculateMetrics(
                        trades,
                        trades.length,
                        { long: 1, short: 2, neutral: 3 },
                        365 * 24,
                    );
                    const second = calculateMetrics(
                        trades,
                        trades.length,
                        { long: 1, short: 2, neutral: 3 },
                        365 * 24,
                    );

                    // A backtest whose numbers move between two runs of the
                    // same code is a backtest nobody can act on.
                    expect(second).toEqual(first);
                },
            ),
            { numRuns: 200 },
        );
    });
});
