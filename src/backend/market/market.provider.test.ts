import { describe, expect, it, vi } from 'vitest';

import { FailoverProvider } from './failover.provider.js';

describe('marketDataProvider', () => {
    it('creates FailoverProvider for the binance configuration', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');

        const { marketDataProvider } =
            await import('./market.provider');

        // The primary is wrapped rather than returned on its own: the backup is
        // on by default, and a deployment that has to edit a setting before a
        // dead venue is survivable is a deployment where nobody edits it.
        expect(
            marketDataProvider.constructor.name,
        ).toBe('FailoverProvider');
        expect('activeVenue' in marketDataProvider).toBe(true);
        expect(
            (marketDataProvider as FailoverProvider).activeVenue,
        ).toBe('binance');

        expect(
            typeof marketDataProvider.getPrice,
        ).toBe('function');

        expect(
            typeof marketDataProvider.getCandles,
        ).toBe('function');

        vi.unstubAllEnvs();
    });

    it('returns the primary unwrapped when no backup is configured', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', '');

        const { marketDataProvider } =
            await import('./market.provider');

        expect(
            marketDataProvider.constructor.name,
        ).toBe('BinanceProvider');

        vi.unstubAllEnvs();
    });

    it('creates MockProvider for the mock configuration', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const { marketDataProvider } =
            await import('./market.provider');

        // Not a FailoverProvider: a mock primary has no backup, so the suite
        // and a laptop keep running with no network at all.
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
