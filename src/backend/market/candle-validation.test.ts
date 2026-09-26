import { describe, expect, it } from 'vitest';

import { MAX_CANDLE_LIMIT } from '../config/market.config.js';
import { MarketDataError } from '../errors/market-data.error.js';
import { assertCandleSeries, findCandleSeriesIssues } from './candle-validation.js';

import type { Candle } from '../types/market.js';

const HOUR_MS = 3_600_000;
const NOW = 1_700_000_000_000;

function candle(overrides: Partial<Candle> = {}): Candle {
    return {
        timestamp: NOW - HOUR_MS,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        ...overrides,
    };
}

function series(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => candle({
        timestamp: NOW - (count - index) * HOUR_MS,
    }));
}

describe('findCandleSeriesIssues', () => {
    it('accepts a well-formed series', () => {
        expect(findCandleSeriesIssues(series(5), NOW)).toBeNull();
    });

    it('rejects an empty series', () => {
        expect(findCandleSeriesIssues([], NOW)).toBe('empty');
    });

    it('rejects a series longer than the provider can serve', () => {
        const oversized = series(MAX_CANDLE_LIMIT + 1);

        expect(findCandleSeriesIssues(oversized, NOW)).toBe('too_many');
    });

    it('accepts a series exactly at the cap', () => {
        expect(findCandleSeriesIssues(series(MAX_CANDLE_LIMIT), NOW)).toBeNull();
    });

    it('rejects a repeated timestamp', () => {
        // A duplicate would be counted twice by every indicator, quietly
        // weighting that hour more heavily than any other.
        const candles = [
            candle({ timestamp: NOW - 2 * HOUR_MS }),
            candle({ timestamp: NOW - 2 * HOUR_MS }),
            candle({ timestamp: NOW - HOUR_MS }),
        ];

        expect(findCandleSeriesIssues(candles, NOW)).toBe('duplicate');
    });

    it('rejects an out-of-order series', () => {
        const candles = [
            candle({ timestamp: NOW - HOUR_MS }),
            candle({ timestamp: NOW - 3 * HOUR_MS }),
        ];

        expect(findCandleSeriesIssues(candles, NOW)).toBe('not_increasing');
    });

    it('rejects a bar that has not opened yet', () => {
        const candles = [candle({ timestamp: NOW + HOUR_MS })];

        expect(findCandleSeriesIssues(candles, NOW)).toBe('from_the_future');
    });

    it('rejects a high below the low', () => {
        expect(findCandleSeriesIssues([candle({ high: 50 })], NOW)).toBe(
            'ohlc_inconsistent',
        );
    });

    it('rejects a close above the high', () => {
        expect(findCandleSeriesIssues([candle({ close: 500 })], NOW)).toBe(
            'ohlc_inconsistent',
        );
    });

    it('rejects an open above the high', () => {
        expect(findCandleSeriesIssues([candle({ open: 500 })], NOW)).toBe(
            'ohlc_inconsistent',
        );
    });

    it('rejects a close below the low', () => {
        expect(findCandleSeriesIssues([candle({ close: 1 })], NOW)).toBe(
            'ohlc_inconsistent',
        );
    });

    it('accepts a flat bar where open equals close', () => {
        expect(
            findCandleSeriesIssues(
                [candle({ open: 100, high: 100, low: 100, close: 100 })],
                NOW,
            ),
        ).toBeNull();
    });

    it('rejects a negative price', () => {
        expect(findCandleSeriesIssues([candle({ low: -1 })], NOW)).toBe(
            'negative',
        );
    });

    it('rejects a negative volume', () => {
        expect(findCandleSeriesIssues([candle({ volume: -1 })], NOW)).toBe(
            'negative',
        );
    });

    it('rejects a non-finite price', () => {
        expect(
            findCandleSeriesIssues([candle({ close: Number.NaN })], NOW),
        ).toBe('not_finite');
    });

    it('rejects an infinite value', () => {
        expect(
            findCandleSeriesIssues([candle({ high: Number.POSITIVE_INFINITY })], NOW),
        ).toBe('not_finite');
    });

    it('accepts a zero volume, which is a real market state', () => {
        expect(findCandleSeriesIssues([candle({ volume: 0 })], NOW)).toBeNull();
    });

    it('rejects a hole in the middle, not only at the ends', () => {
        const candles = series(3);
        candles[1] = { ...(candles[1] as Candle), high: 1 };

        expect(findCandleSeriesIssues(candles, NOW)).toBe('ohlc_inconsistent');
    });
});

describe('gaps and staleness', () => {
    /** A series that stops at `newest`, every bar one hour apart. */
    function hourlyEndingAt(newest: number, count = 5): Candle[] {
        return Array.from({ length: count }, (_unused, index) => candle({
            timestamp: newest - (count - 1 - index) * HOUR_MS,
        }));
    }

    it('reports a hole in the middle of the series', () => {
        const series = [
            candle({ timestamp: NOW - 4 * HOUR_MS }),
            candle({ timestamp: NOW - 3 * HOUR_MS }),
            // The 2-hour-ago bar never arrived.
            candle({ timestamp: NOW - HOUR_MS }),
            candle({ timestamp: NOW }),
        ];

        // Every other check passes: sorted, unique, finite, consistent ranges.
        // The indicators do not care — the EMA's decay and momentum's lookback
        // are both functions of the distance between bars, so a missing bar is
        // a discontinuity they step over in silence.
        expect(findCandleSeriesIssues(series, NOW, MAX_CANDLE_LIMIT)).toBeNull();
        expect(
            findCandleSeriesIssues(series, NOW, MAX_CANDLE_LIMIT, HOUR_MS),
        ).toBe('has_gap');
    });

    it('accepts a series with a still-forming newest bar', () => {
        // The newest bar opened an hour ago and has not closed yet. That is
        // normal, not a gap.
        expect(
            findCandleSeriesIssues(
                hourlyEndingAt(NOW - HOUR_MS + 60_000),
                NOW,
                MAX_CANDLE_LIMIT,
                HOUR_MS,
            ),
        ).toBeNull();
    });

    it('reports a series that stopped updating', () => {
        const stopped = hourlyEndingAt(NOW - 5 * HOUR_MS);

        // Internally perfect, five hours out of date. Signals from it are
        // well-formed answers to a question about a market that has moved on.
        expect(
            findCandleSeriesIssues(stopped, NOW, MAX_CANDLE_LIMIT, HOUR_MS),
        ).toBe('stale');
    });

    it('does not judge gaps or staleness without an interval', () => {
        // A backtest sample is multi-page and may legitimately be sparse; the
        // caller that knows the interval is the one that asks the question.
        const series = [candle({ timestamp: NOW - 40 * HOUR_MS }), candle({ timestamp: NOW })];

        expect(findCandleSeriesIssues(series, NOW)).toBeNull();
    });

    it('rejects a gapped series as a provider failure', () => {
        expect(() =>
            assertCandleSeries(
                [candle({ timestamp: NOW - 4 * HOUR_MS }), candle({ timestamp: NOW })],
                NOW,
                'binance',
                MAX_CANDLE_LIMIT,
                HOUR_MS,
            ),
        ).toThrow(MarketDataError);
    });
});

describe('assertCandleSeries', () => {
    it('passes a well-formed series through', () => {
        expect(() => assertCandleSeries(series(3), NOW, 'binance')).not.toThrow();
    });

    it('reports the issue and the provider in the cause', () => {
        let caught: unknown;

        try {
            assertCandleSeries(
                [candle({ timestamp: NOW }), candle({ timestamp: NOW })],
                NOW,
                'binance',
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(MarketDataError);
        expect(caught).toMatchObject({
            code: 'MARKET_PROVIDER_ERROR',
            statusCode: 502,
            cause: {
                provider: 'binance',
                issue: 'duplicate',
            },
        });
    });

    it('keeps the internal reason out of the public message', () => {
        let caught: unknown;

        try {
            assertCandleSeries([candle({ close: 500 })], NOW, 'mock');
        } catch (error) {
            caught = error;
        }

        // The specific violation is useful in the logs but tells an attacker
        // nothing worth hiding and nothing worth exposing in a response.
        expect((caught as Error).message).toBe(
            'Market data provider returned an inconsistent candle series',
        );
    });
});
