import { describe, expect, it, vi } from 'vitest';

describe('marketDataProvider', () => {
    it('creates BinanceProvider for the binance configuration', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');

        const { marketDataProvider } =
            await import('./market.provider');

        expect(
            marketDataProvider.constructor.name,
        ).toBe('BinanceProvider');

        expect(
            typeof marketDataProvider.getPrice,
        ).toBe('function');

        expect(
            typeof marketDataProvider.getCandles,
        ).toBe('function');

        vi.unstubAllEnvs();
    });

    it('creates MockProvider for the mock configuration', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const { marketDataProvider } =
            await import('./market.provider');

        expect(
            marketDataProvider.constructor.name,
        ).toBe('MockProvider');

        expect(
            typeof marketDataProvider.getPrice,
        ).toBe('function');

        expect(
            typeof marketDataProvider.getCandles,
        ).toBe('function');

        vi.unstubAllEnvs();
    });
});
