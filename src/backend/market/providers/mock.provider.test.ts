import { describe, expect, it } from 'vitest';

import { MAX_CANDLE_LIMIT, marketConfig } from '../../config/market.config.js';
import { assertCandleSeries } from '../candle-validation.js';
import { MockProvider } from './mock.provider.js';

describe('MockProvider', () => {
    it('returns a mock market price for the configured symbol', async () => {
        const provider = new MockProvider();

        const result = await provider.getPrice();

        expect(result).toEqual({
            symbol: marketConfig.symbol,
            price: 100000,
        });
    });

    it('returns one candle fewer than requested, like Binance', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles();

        // Binance always ends a klines response with the bar that is still
        // forming, and the provider layer drops it. The mock used to return a
        // full `limit`, which hid the off-by-one in the warm-up window.
        expect(result).toHaveLength(
            marketConfig.defaultCandleLimit - 1,
        );
    });

    it('returns the requested number of closed candles', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles(10);

        expect(result).toHaveLength(9);
    });

    it('returns nothing when asked for a single bar', async () => {
        const provider = new MockProvider();

        // That one bar is the forming one.
        expect(await provider.getCandles(1)).toEqual([]);
    });

    it('never returns a negative count for a zero limit', async () => {
        const provider = new MockProvider();

        expect(await provider.getCandles(0)).toEqual([]);
    });

    it('returns candles with the expected structure', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles(2);

        // The absolute label moves with the clock — the mock is anchored to the
        // current hour, so that a series it produces is not rejected as stale by
        // the same validation every real provider's output goes through. The
        // shape is what is fixed.
        expect(result[0]).toEqual({
            timestamp: expect.any(Number),
            open: 99990,
            high: 100010,
            low: 99980,
            close: 100000,
            volume: 1000,
        });
    });

    it('generates candles with hourly timestamps and increasing prices', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles(4);

        expect(result).toHaveLength(3);

        // Relative, not absolute: what matters is that the bars are one hour
        // apart, not which hour they are labelled with.
        expect(result[1]?.timestamp).toBe(
            (result[0]?.timestamp ?? 0) + 60 * 60 * 1000,
        );

        expect(result[2]?.timestamp).toBe(
            (result[1]?.timestamp ?? 0) + 60 * 60 * 1000,
        );

        expect(result[0]?.close).toBe(100000);
        expect(result[1]?.close).toBe(100001);
        expect(result[2]?.close).toBe(100002);
    });

    it('produces a series that is current, not frozen in the past', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles(10);
        const newest = result.at(-1);

        // The defect this fixes: the mock used to answer with a series ending
        // in November 2023, so a dashboard running on it showed a signal for
        // a market that stopped trading years ago, with no staleness flag.
        expect(newest?.timestamp).toBeGreaterThan(Date.now() - 2 * 3_600_000);
    });

    it('passes the same validation that a real provider must pass', async () => {
        const provider = new MockProvider();
        const candles = await provider.getCandles(10);

        // A test double that cannot survive the checks the real thing is held
        // to is a test double that quietly lets those checks rot.
        expect(() =>
            assertCandleSeries(
                candles,
                Date.now(),
                'mock',
                MAX_CANDLE_LIMIT,
                marketConfig.candleIntervalMs,
            ),
        ).not.toThrow();
    });
});
