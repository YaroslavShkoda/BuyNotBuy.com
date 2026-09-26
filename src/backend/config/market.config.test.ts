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
        delete process.env.MARKET_CACHE_TTL_MS;
        delete process.env.MARKET_MAX_STALE_MS;

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            baseUrl: 'https://data-api.binance.vision',
            symbol: 'BTCUSDT',
            candleInterval: '1h',
            defaultCandleLimit: 900,
            requestTimeoutMs: 10000,
            cacheTtlMs: 60000,
            maxStaleMs: 3600000,
            maxRetries: 2,
            retryBaseDelayMs: 250,
            retryMaxDelayMs: 5000,
            circuitFailureThreshold: 5,
            circuitCooldownMs: 30000,
            maxRetryAfterMs: 120000,
            userAgent: 'BuyNotBuy.com/1.0 (+https://buynotbuy.com)',
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
        process.env.MARKET_CACHE_TTL_MS = '15000';
        process.env.MARKET_MAX_STALE_MS = '120000';
        process.env.MARKET_MAX_RETRIES = '4';
        process.env.MARKET_RETRY_BASE_DELAY_MS = '100';
        process.env.MARKET_RETRY_MAX_DELAY_MS = '2000';
        process.env.MARKET_CIRCUIT_FAILURE_THRESHOLD = '3';
        process.env.MARKET_CIRCUIT_COOLDOWN_MS = '15000';
        process.env.MARKET_MAX_RETRY_AFTER_MS = '90000';
        process.env.MARKET_USER_AGENT = 'Custom/9.9';

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            baseUrl: 'https://example.com',
            symbol: 'ETHUSDT',
            candleInterval: '15m',
            defaultCandleLimit: 500,
            requestTimeoutMs: 5000,
            cacheTtlMs: 15000,
            maxStaleMs: 120000,
            maxRetries: 4,
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 2000,
            circuitFailureThreshold: 3,
            circuitCooldownMs: 15000,
            maxRetryAfterMs: 90000,
            userAgent: 'Custom/9.9',
        });
    });

    it('rejects an unsupported provider', async () => {
        vi.resetModules();

        process.env.MARKET_PROVIDER = 'unsupported';

        await expect(import('./market.config')).rejects.toThrow();
    });

    it('accepts plaintext HTTP only on loopback, where it carries no market data', async () => {
        vi.resetModules();

        delete process.env.MARKET_PROVIDER;

        for (const baseUrl of [
            'http://localhost:3000',
            'http://127.0.0.1:8080',
            'http://[::1]:8080',
        ]) {
            vi.resetModules();
            process.env.MARKET_BASE_URL = baseUrl;

            const { marketConfig } = await import('./market.config');

            // A local mock or proxy is a normal development setup; forbidding
            // it would only push people towards turning the check off.
            expect(marketConfig.baseUrl).toBe(baseUrl);
        }
    });

    it('rejects invalid market configuration values', async () => {        const validEnv: Record<string, string> = {
            MARKET_PROVIDER: 'binance',
            MARKET_BASE_URL: 'https://example.com',
            MARKET_SYMBOL: 'BTCUSDT',
            MARKET_CANDLE_INTERVAL: '1h',
            MARKET_DEFAULT_CANDLE_LIMIT: '300',
            MARKET_REQUEST_TIMEOUT_MS: '5000',
            MARKET_CACHE_TTL_MS: '60000',
            MARKET_MAX_STALE_MS: '3600000',
            MARKET_MAX_RETRIES: '2',
            MARKET_RETRY_BASE_DELAY_MS: '250',
            MARKET_RETRY_MAX_DELAY_MS: '5000',
            MARKET_CIRCUIT_FAILURE_THRESHOLD: '5',
            MARKET_CIRCUIT_COOLDOWN_MS: '30000',
            MARKET_MAX_RETRY_AFTER_MS: '120000',
            MARKET_USER_AGENT: 'BuyNotBuy.com/1.0 (+https://buynotbuy.com)',
        };

        const cases: Record<string, string>[] = [
            { MARKET_PROVIDER: 'unknown' },
            { MARKET_DEFAULT_CANDLE_LIMIT: '0' },
            { MARKET_DEFAULT_CANDLE_LIMIT: '-1' },
            { MARKET_DEFAULT_CANDLE_LIMIT: 'abc' },
            { MARKET_DEFAULT_CANDLE_LIMIT: '1001' },
            { MARKET_REQUEST_TIMEOUT_MS: '0' },
            { MARKET_REQUEST_TIMEOUT_MS: '-1' },
            { MARKET_REQUEST_TIMEOUT_MS: 'abc' },
            { MARKET_CACHE_TTL_MS: '-1' },
            { MARKET_CACHE_TTL_MS: 'abc' },
            { MARKET_MAX_STALE_MS: '-1' },
            { MARKET_MAX_STALE_MS: 'abc' },
            { MARKET_MAX_RETRIES: '-1' },
            { MARKET_MAX_RETRIES: '6' },
            { MARKET_MAX_RETRIES: 'abc' },
            { MARKET_RETRY_BASE_DELAY_MS: '-1' },
            { MARKET_RETRY_MAX_DELAY_MS: '-1' },
            { MARKET_CIRCUIT_FAILURE_THRESHOLD: '0' },
            { MARKET_CIRCUIT_COOLDOWN_MS: '-1' },
            { MARKET_MAX_RETRY_AFTER_MS: '-1' },
            { MARKET_USER_AGENT: '' },
            { MARKET_BASE_URL: 'not-a-url' },
            { MARKET_BASE_URL: 'ftp://example.com' },
            { MARKET_BASE_URL: 'file:///tmp/market-data' },
            { MARKET_BASE_URL: 'http://data-api.binance.vision' },
            { MARKET_BASE_URL: 'ws://example.com' },
            { MARKET_SYMBOL: '' },
            { MARKET_SYMBOL: 'btc usdt' },
            { MARKET_SYMBOL: 'BTC-USDT' },
            { MARKET_SYMBOL: 'BTCUSDT&extra=1' },
            { MARKET_SYMBOL: 'B'.repeat(33) },
            { MARKET_CANDLE_INTERVAL: '' },
            { MARKET_CANDLE_INTERVAL: '1 hour' },
            { MARKET_CANDLE_INTERVAL: 'hourly' },
            { MARKET_CANDLE_INTERVAL: '1h&limit=1000' },
        ];

        for (const env of cases) {
            vi.resetModules();

            Object.assign(process.env, validEnv, env);

            await expect(import('./market.config')).rejects.toThrow();

            delete process.env.MARKET_PROVIDER;
            delete process.env.MARKET_BASE_URL;
            delete process.env.MARKET_SYMBOL;
            delete process.env.MARKET_CANDLE_INTERVAL;
            delete process.env.MARKET_DEFAULT_CANDLE_LIMIT;
            delete process.env.MARKET_REQUEST_TIMEOUT_MS;
            delete process.env.MARKET_CACHE_TTL_MS;
            delete process.env.MARKET_MAX_STALE_MS;
            delete process.env.MARKET_MAX_RETRIES;
            delete process.env.MARKET_RETRY_BASE_DELAY_MS;
            delete process.env.MARKET_RETRY_MAX_DELAY_MS;
            delete process.env.MARKET_CIRCUIT_FAILURE_THRESHOLD;
            delete process.env.MARKET_CIRCUIT_COOLDOWN_MS;
            delete process.env.MARKET_MAX_RETRY_AFTER_MS;
            delete process.env.MARKET_USER_AGENT;
        }
    });
});
