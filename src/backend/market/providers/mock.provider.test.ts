import { describe, expect, it } from 'vitest';

import { marketConfig } from '../../config/market.config.js';
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

        expect(result[0]).toEqual({
            timestamp: 1_700_000_000_000,
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

        expect(result[0]?.timestamp).toBe(
            1_700_000_000_000,
        );

        expect(result[1]?.timestamp).toBe(
            1_700_000_000_000 + 60 * 60 * 1000,
        );

        expect(result[2]?.timestamp).toBe(
            1_700_000_000_000 + 2 * 60 * 60 * 1000,
        );

        expect(result[0]?.close).toBe(100000);
        expect(result[1]?.close).toBe(100001);
        expect(result[2]?.close).toBe(100002);
    });
});
