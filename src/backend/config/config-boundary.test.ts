import { afterEach, describe, expect, it, vi } from 'vitest';

const MARKET_ENV_KEYS = [
    'MARKET_PROVIDER',
    'MARKET_BASE_URL',
    'MARKET_SYMBOL',
    // Clearing the backup settings matters exactly as much as the primary ones:
    // a leftover MARKET_FALLBACK_PROVIDERS from a neighbouring test would
    // decide whether the provider is wrapped, and the factory is built once per
    // import.
    'MARKET_FALLBACK_PROVIDERS',
    'MARKET_FALLBACK_BASE_URL',
    'MARKET_FALLBACK_SYMBOL',
    'MARKET_CANDLE_INTERVAL',
    'MARKET_DEFAULT_CANDLE_LIMIT',
    'MARKET_REQUEST_TIMEOUT_MS',
    'MARKET_CACHE_TTL_MS',
    'MARKET_MAX_STALE_MS',
    'MARKET_MAX_RETRIES',
    'MARKET_RETRY_BASE_DELAY_MS',
    'MARKET_RETRY_MAX_DELAY_MS',
    'MARKET_CIRCUIT_FAILURE_THRESHOLD',
    'MARKET_CIRCUIT_COOLDOWN_MS',
    'MARKET_MAX_RETRY_AFTER_MS',
    'MARKET_USER_AGENT',
] as const;

const VALID_ENV: Record<string, string> = {
    MARKET_PROVIDER: 'binance',
    MARKET_BASE_URL: 'https://example.com',
    MARKET_SYMBOL: 'BTCUSDT',
    MARKET_CANDLE_INTERVAL: '1h',
    MARKET_DEFAULT_CANDLE_LIMIT: '900',
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

function clearMarketEnv(): void {
    for (const key of MARKET_ENV_KEYS) {
        delete process.env[key];
    }
}

afterEach(() => {
    clearMarketEnv();
    vi.unstubAllEnvs();
});

describe('configuration boundary hardening (task 7)', () => {
    it('valid binance config parses all env values at the boundary', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'binance',
        });

        const { marketConfig } = await import('./market.config');

        expect(marketConfig).toEqual({
            provider: 'binance',
            fallbackProviders: ['bitget'],
            baseUrl: 'https://example.com',
            fallbackBaseUrl: 'https://api.bitget.com',
            symbol: 'BTCUSDT',
            fallbackSymbol: 'BTCUSDT',
            candleInterval: '1h',
            defaultCandleLimit: 900,
            requestTimeoutMs: 5000,
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

    it('valid mock config carries custom symbol/interval/limit/timeout', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'mock',
            MARKET_SYMBOL: 'ETHUSDT',
            MARKET_CANDLE_INTERVAL: '15m',
            MARKET_DEFAULT_CANDLE_LIMIT: '500',
            MARKET_REQUEST_TIMEOUT_MS: '2500',
        });

        const { marketConfig } = await import('./market.config');

        expect(marketConfig.provider).toBe('mock');
        expect(marketConfig.symbol).toBe('ETHUSDT');
        expect(marketConfig.candleInterval).toBe('15m');
        expect(marketConfig.defaultCandleLimit).toBe(500);
        expect(marketConfig.requestTimeoutMs).toBe(2500);
    });

    it('invalid configuration fails at import-time, before any HTTP request', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'unknown',
        });

        await expect(import('./market.config')).rejects.toThrow();
    });

    it('invalid numeric strings fail instead of becoming NaN runtime behaviour', async () => {
        for (const env of [
            { MARKET_DEFAULT_CANDLE_LIMIT: 'abc' },
            { MARKET_REQUEST_TIMEOUT_MS: 'abc' },
            { MARKET_CACHE_TTL_MS: 'abc' },
            { MARKET_CACHE_TTL_MS: '-1' },
            { MARKET_MAX_STALE_MS: 'abc' },
            { MARKET_MAX_STALE_MS: '-1' },
            { MARKET_MAX_RETRIES: '-1' },
            { MARKET_MAX_RETRIES: '6' },
            { MARKET_RETRY_BASE_DELAY_MS: '-1' },
            { MARKET_RETRY_MAX_DELAY_MS: '-1' },
            { MARKET_CIRCUIT_FAILURE_THRESHOLD: '0' },
            { MARKET_CIRCUIT_COOLDOWN_MS: '-1' },
            { MARKET_MAX_RETRY_AFTER_MS: '-1' },
            { MARKET_USER_AGENT: '' },
        ]) {
            vi.resetModules();
            clearMarketEnv();
            Object.assign(process.env, { ...VALID_ENV, ...env });

            await expect(import('./market.config')).rejects.toThrow();
        }
    });

    it('mock env selects MockProvider and binance env selects a failing-over provider', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'mock',
        });

        const mockModule = await import('../market/market.provider');

        // A mock primary keeps no backup, so the suite still runs with no network.
        expect(mockModule.marketDataProvider.constructor.name).toBe(
            'MockProvider',
        );

        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'binance',
        });

        const binanceModule = await import('../market/market.provider');

        expect(binanceModule.marketDataProvider.constructor.name).toBe(
            'FailoverProvider',
        );
    });

    it('unknown provider has no silent fallback: config boundary rejects it', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'unknown',
        });

        await expect(import('../market/market.provider')).rejects.toThrow();
    });

    it('env does not leak between tests after stubbing', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'mock',
        });

        const { marketConfig } = await import('./market.config');

        expect(marketConfig.provider).toBe('mock');

        clearMarketEnv();

        vi.resetModules();

        const { marketConfig: defaults } = await import('./market.config');

        expect(defaults.provider).toBe('binance');
        expect(defaults.defaultCandleLimit).toBe(900);
    });
});
