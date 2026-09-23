import { afterEach, describe, expect, it, vi } from 'vitest';

const MARKET_ENV_KEYS = [
    'MARKET_PROVIDER',
    'MARKET_BASE_URL',
    'MARKET_SYMBOL',
    'MARKET_CANDLE_INTERVAL',
    'MARKET_DEFAULT_CANDLE_LIMIT',
    'MARKET_REQUEST_TIMEOUT_MS',
] as const;

const VALID_ENV: Record<string, string> = {
    MARKET_PROVIDER: 'binance',
    MARKET_BASE_URL: 'https://example.com',
    MARKET_SYMBOL: 'BTCUSDT',
    MARKET_CANDLE_INTERVAL: '1h',
    MARKET_DEFAULT_CANDLE_LIMIT: '300',
    MARKET_REQUEST_TIMEOUT_MS: '5000',
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
            baseUrl: 'https://example.com',
            symbol: 'BTCUSDT',
            candleInterval: '1h',
            defaultCandleLimit: 300,
            requestTimeoutMs: 5000,
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
        ]) {
            vi.resetModules();
            clearMarketEnv();
            Object.assign(process.env, { ...VALID_ENV, ...env });

            await expect(import('./market.config')).rejects.toThrow();
        }
    });

    it('mock env selects MockProvider and binance env selects BinanceProvider', async () => {
        vi.resetModules();
        clearMarketEnv();
        Object.assign(process.env, {
            ...VALID_ENV,
            MARKET_PROVIDER: 'mock',
        });

        const mockModule = await import('../market/market.provider');

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
            'BinanceProvider',
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
        expect(defaults.defaultCandleLimit).toBe(300);
    });
});
