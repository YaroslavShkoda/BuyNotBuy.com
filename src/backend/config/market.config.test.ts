import { describe, expect, it, vi } from 'vitest';

describe('marketConfig', () => {
    it('loads default configuration', async () => {
        vi.resetModules();

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            baseUrl: 'https://data-api.binance.vision',
            symbol: 'BTCUSDT',
            candleInterval: '1h',
            defaultCandleLimit: 300,
        });
    });

    it('loads configuration from environment variables', async () => {
        process.env.MARKET_PROVIDER = 'binance';
        process.env.MARKET_BASE_URL = 'https://example.com';
        process.env.MARKET_SYMBOL = 'ETHUSDT';
        process.env.MARKET_CANDLE_INTERVAL = '15m';
        process.env.MARKET_DEFAULT_CANDLE_LIMIT = '500';

        vi.resetModules();

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            baseUrl: 'https://example.com',
            symbol: 'ETHUSDT',
            candleInterval: '15m',
            defaultCandleLimit: 500,
        });

        delete process.env.MARKET_PROVIDER;
        delete process.env.MARKET_BASE_URL;
        delete process.env.MARKET_SYMBOL;
        delete process.env.MARKET_CANDLE_INTERVAL;
        delete process.env.MARKET_DEFAULT_CANDLE_LIMIT;
    });

    it('rejects an unsupported provider', async () => {
        process.env.MARKET_PROVIDER = 'unknown';

        vi.resetModules();

        await expect(
            import('./market.config'),
        ).rejects.toThrow();

        delete process.env.MARKET_PROVIDER;
    });
});
