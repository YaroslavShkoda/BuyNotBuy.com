import { describe, expect, it } from 'vitest';

import {
    assertCandleSeries,
    assertHistoricalCandleSeries,
    findCandleContinuityIssue,
    findCandleSeriesIssues,
} from './candle-validation.js';

import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
const NOW = 1_800 * HOUR;

/**
 * The backtest path, which for seven days of this project's history measured
 * across holes in the candle series without anyone noticing.
 *
 * `backtest.service.ts` called `assertCandleSeries(candles, now, provider,
 * count)` with no interval. The interval was not one optional check, it was two
 * — continuity and freshness — so leaving it out switched off both, and the
 * comment above the call claimed parity with the live path. The series was still
 * verified as sorted, unique, finite and range-consistent; a gap violates none
 * of those. Every indicator in this codebase is a function of the distance
 * between consecutive bars, so the result was a well-formed number computed
 * across a discontinuity, which is the failure the whole file exists to prevent.
 */
const candle = (timestamp: number, close = 100): Candle => ({
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
});

/**
 * Oldest first, as `test-support/candles.ts` builds them and as the codebase
 * assumes throughout — `candles[candles.length - 1]` is the newest bar.
 *
 * Written descending the first time. That is what produced both of the failures
 * this file started with, and neither said anything about the code: a series
 * running backwards trips `not_increasing` before continuity is ever reached.
 * The fixture's own docstring says "a fixture whose timestamp is `Date.now()`
 * while its newest candle is not is a lie the assertions cannot survive", which
 * is the same rule one level up.
 */
const series = (count: number, hoursAgo = 1): Candle[] =>
    Array.from({ length: count }, (_, index) =>
        candle(NOW - (hoursAgo + count - 1 - index) * HOUR, 100 + index),
    );

/** The same series with one bar missing from the middle. */
const gapped = (count: number, hoursAgo = 1): Candle[] =>
    series(count, hoursAgo).filter((_, index) => index !== Math.floor(count / 2));

describe('a historical series is checked for continuity', () => {
    it('refuses a hole the live path would have refused', () => {
        // The regression. This call threw nothing before the fix, and the
        // backtest went on to produce a report.
        expect(() =>
            assertHistoricalCandleSeries(
                gapped(20),
                NOW,
                'binance',
                1_000,
                HOUR,
            ),
        ).toThrow(/inconsistent candle series/);
    });

    it('names the hole, so the failure is diagnosable', () => {
        expect(
            assertHistoricalCandleSeries.length,
        ).toBeGreaterThan(0);
        expect(findCandleContinuityIssue(gapped(20), HOUR)).toBe('has_gap');
        expect(findCandleContinuityIssue(series(20), HOUR)).toBeNull();
    });

    it('accepts a series that is old on purpose', () => {
        // The reason freshness cannot come along: a backtest measures history,
        // so the live check would refuse every run it was given.
        expect(() =>
            assertHistoricalCandleSeries(series(20, 900), NOW, 'binance', 1_000, HOUR),
        ).not.toThrow();

        // And the live check does refuse it, which is why the two are separate.
        expect(() =>
            assertCandleSeries(series(20, 900), NOW, 'binance', 1_000, HOUR),
        ).toThrow(/inconsistent candle series/);
    });

    it('still refuses the checks that do not need an interval', () => {
        // Splitting the two must not have cost the shared ones. Every one of
        // these passed before the fix too, and all of them still must.
        expect(
            findCandleSeriesIssues([], NOW, 1_000, HOUR, false),
        ).toBe('empty');
        expect(
            findCandleSeriesIssues([candle(NOW + HOUR)], NOW, 1_000, HOUR, false),
        ).toBe('from_the_future');
        expect(
            findCandleSeriesIssues([candle(NOW, Number.NaN)], NOW, 1_000, HOUR, false),
        ).toBe('not_finite');
    });

    it('keeps a future bar out of a historical run too', () => {
        // The live check's other use of `now`. A backtest must not be handed a
        // series containing a bar that had not opened yet, or it measures a
        // guess.
        expect(() =>
            assertHistoricalCandleSeries(
                [candle(NOW + HOUR), ...series(10)],
                NOW,
                'binance',
                1_000,
                HOUR,
            ),
        ).toThrow(/inconsistent candle series/);
    });
});