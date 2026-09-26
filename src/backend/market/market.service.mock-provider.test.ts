import { describe, expect, it, vi } from 'vitest';

describe('market.service with MockProvider', () => {
    it('returns market data from MockProvider', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const {
            getMarketData,
        } = await import('./market.service');

        const { data, stale } = await getMarketData();

        expect(stale).toBe(false);

        expect(data.price).toEqual({
            symbol: 'BTCUSDT',
            price: 100899,
        });

        expect(data.candles).toHaveLength(900);

        expect(data.candles[0]).toEqual({
            timestamp: 1_700_000_000_000,
            open: 99990,
            high: 100010,
            low: 99980,
            close: 100000,
            volume: 1000,
        });

        expect(data.candles[899]).toEqual({
            timestamp:
                1_700_000_000_000 +
                899 * 60 * 60 * 1000,
            open: 100889,
            high: 100909,
            low: 100879,
            close: 100899,
            volume: 1000,
        });

        vi.unstubAllEnvs();
    });
});
