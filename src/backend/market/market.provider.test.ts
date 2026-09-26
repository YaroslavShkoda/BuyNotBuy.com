import { describe, expect, it, vi } from 'vitest';

import { FailoverProvider } from './failover.provider.js';
import { createVenueWatcher } from './market.provider.js';

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

describe('reporting which venue is answering', () => {
    it('says nothing about a venue when there is nothing to switch', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const { activeMarketVenue } = await import('./market.provider');

        expect(activeMarketVenue()).toBeNull();

        vi.unstubAllEnvs();
    });

    it('names the primary while it is healthy', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');

        const { activeMarketVenue } = await import('./market.provider');

        expect(activeMarketVenue()).toBe('binance');

        vi.unstubAllEnvs();
    });
});

describe('venue change reporting', () => {
    function watcherFor(venues: (string | null)[]) {
        const warn = vi.fn();
        const info = vi.fn();
        let index = 0;

        const report = createVenueWatcher(
            { warn, info },
            () => venues[Math.min(index++, venues.length - 1)] ?? null,
        );

        return { warn, info, report };
    }

    it('announces the venue at startup without calling it a failover', () => {
        // Every restart would otherwise open with a warning that the primary
        // had failed, which trains an operator to ignore the real one.
        const { warn, info, report } = watcherFor(['binance']);

        report();

        expect(warn).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
            {
                event: 'market_venue_active',
                venue: 'binance',
                primary: 'binance',
                onBackup: false,
            },
            'market_venue_active',
        );
    });

    it('says a service that boots on the backup is on the backup', () => {
        // The primary was already unreachable when the process started, so no
        // switch will ever be observed — the line has to carry that itself.
        const { info, report } = watcherFor(['bitget']);

        report();

        expect(info).toHaveBeenCalledWith(
            {
                event: 'market_venue_active',
                venue: 'bitget',
                primary: 'binance',
                onBackup: true,
            },
            'market_venue_active',
        );
    });

    it('warns once when the venue changes, and not again while it holds', () => {
        // The whole point of the feature. Two venues do not print the same
        // price, so a silent switch reads as a market move in every metric.
        const { warn, report } = watcherFor(['binance', 'bitget', 'bitget']);

        report();
        report();
        report();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            { event: 'market_venue_switched', from: 'binance', to: 'bitget' },
            'market_venue_switched',
        );
    });

    it('warns again when the primary comes back', () => {
        const { warn, report } = watcherFor(['binance', 'bitget', 'binance']);

        report();
        report();
        report();

        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenLastCalledWith(
            { event: 'market_venue_switched', from: 'bitget', to: 'binance' },
            'market_venue_switched',
        );
    });

    it('stays quiet when there is no venue to name', () => {
        const { warn, info, report } = watcherFor([null]);

        report();
        report();

        expect(warn).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });
});
