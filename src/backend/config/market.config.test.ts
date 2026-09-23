import { describe, expect, it, vi } from 'vitest';

describe('marketConfig', () => {
    it('loads default configuration', async () => {
        vi.resetModules();

        delete process.env.MARKET_PROVIDER;
        delete process.env.MARKET_BASE_URL;
        delete process.env.MARKET_SYMBOL;
        delete process.env.MARKET_CANDLE_INTERVAL;
        delete process.env.MARKET_DEFAULT_CANDLE_LIMIT;
        delete process.env.MARKET_REQUEST_TIMEOUT_MS;

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            baseUrl: 'https://data-api.binance.vision',
            symbol: 'BTCUSDT',
            candleInterval: '1h',
            defaultCandleLimit: 300,
            requestTimeoutMs: 10000,
        });
    });

    it('loads configuration from environment variables', async () => {
        vi.resetModules();

        process.env.MARKET_PROVIDER = 'binance';
        process.env.MARKET_BASE_URL = 'https://example.com';
        process.env.MARKET_SYMBOL = 'ETHUSDT';
        process.env.MARKET_CANDLE_INTERVAL = '15m';
        process.env.MARKET_DEFAULT_CANDLE_LIMIT = '500';
        process.env.MARKET_REQUEST_TIMEOUT_MS = '5000';

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            baseUrl: 'https://example.com',
            symbol: 'ETHUSDT',
            candleInterval: '15m',
            defaultCandleLimit: 500,
            requestTimeoutMs: 5000,
        });
    });

    it('rejects an unsupported provider', async () => {
        vi.resetModules();

        process.env.MARKET_PROVIDER = 'unsupported';

        await expect(import('./market.config')).rejects.toThrow();
    });

    it('rejects invalid market configuration values', async () => {
        const cases: Record<string, string>[] = [
            { MARKET_DEFAULT_CANDLE_LIMIT: '0' },
            { MARKET_DEFAULT_CANDLE_LIMIT: '-5' },
            { MARKET_DEFAULT_CANDLE_LIMIT: 'abc' },
            { MARKET_REQUEST_TIMEOUT_MS: '0' },
            { MARKET_REQUEST_TIMEOUT_MS: '-1' },
            { MARKET_REQUEST_TIMEOUT_MS: 'abc' },
            { MARKET_BASE_URL: 'not-a-url' },
            { MARKET_SYMBOL: '' },
            { MARKET_CANDLE_INTERVAL: '' },
        ];

        for (const env of cases) {
            vi.resetModules();

            Object.assign(process.env, env);

            await expect(import('./market.config')).rejects.toThrow();

            for (const key of Object.keys(env)) {
                delete process.env[key];
            }
        }
    });
});
