import { describe, expect, it, vi } from 'vitest';

describe('market.service with MockProvider', () => {
    it('returns market data from MockProvider', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const {
            getMarketData,
        } = await import('./market.service');

        const result = await getMarketData();

        expect(result.price).toEqual({
            symbol: 'BTCUSDT',
            price: 100000,
        });

        expect(result.candles).toHaveLength(300);

        expect(result.candles[0]).toEqual({
            timestamp: 1_700_000_000_000,
            open: 99990,
            high: 100010,
            low: 99980,
            close: 100000,
            volume: 1000,
        });

        expect(result.candles[299]).toEqual({
            timestamp: 1_700_000_000_000 + 299 * 60 * 60 * 1000,
            open: 100289,
            high: 100309,
            low: 100279,
            close: 100299,
            volume: 1000,
        });

        vi.unstubAllEnvs();
    });

    it('calculates market snapshot without Binance', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const {
            getMarketSnapshot,
        } = await import('./market.service');

        const result = await getMarketSnapshot();

        expect(result.market.price).toEqual({
            symbol: 'BTCUSDT',
            price: 100000,
        });

        expect(result.market.candles).toHaveLength(300);

        expect(result.indicators).toBeDefined();

        vi.unstubAllEnvs();
    });
});
