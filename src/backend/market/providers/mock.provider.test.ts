import { describe, expect, it } from 'vitest';

import { marketConfig } from '../../config/market.config';
import { MockProvider } from './mock.provider';

describe('MockProvider', () => {
    it('returns a mock market price for the configured symbol', async () => {
        const provider = new MockProvider();

        const result = await provider.getPrice();

        expect(result).toEqual({
            symbol: marketConfig.symbol,
            price: 100000,
        });
    });

    it('returns defaultCandleLimit candles by default', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles();

        expect(result).toHaveLength(marketConfig.defaultCandleLimit);
    });

    it('returns the requested number of candles', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles(10);

        expect(result).toHaveLength(10);
    });

    it('returns candles with the expected structure', async () => {
        const provider = new MockProvider();

        const result = await provider.getCandles(1);

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

        const result = await provider.getCandles(3);

        expect(result[0].timestamp).toBe(
            1_700_000_000_000,
        );

        expect(result[1].timestamp).toBe(
            1_700_000_000_000 + 60 * 60 * 1000,
        );

        expect(result[2].timestamp).toBe(
            1_700_000_000_000 + 2 * 60 * 60 * 1000,
        );

        expect(result[0].close).toBe(100000);
        expect(result[1].close).toBe(100001);
        expect(result[2].close).toBe(100002);
    });
});
