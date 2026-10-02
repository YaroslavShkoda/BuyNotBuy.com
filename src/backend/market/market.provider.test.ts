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
    it('names the single venue when there is no backup to switch to', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const { activeMarketVenue, configuredMarketVenues } = await import(
            './market.provider'
        );

        // A snapshot with no venue on it is a record that cannot answer "which
        // exchange published this", and the one-venue deployment is the common
        // case, not an edge case. "Was there a switch?" is the separate
        // question, and it has its own answer.
        expect(activeMarketVenue()).toBe('mock');
        expect(configuredMarketVenues()).toEqual(['mock']);

        vi.unstubAllEnvs();
    });

    it('names the primary while it is healthy', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');

        const { activeMarketVenue, configuredMarketVenues } = await import(
            './market.provider'
        );

        expect(activeMarketVenue()).toBe('binance');
        expect(configuredMarketVenues()).toEqual(['binance', 'bitget']);

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

describe('a routed market gets a venue bound to that market', () => {
    it('serves the market it was routed for, not the configured one', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');
        vi.stubEnv('MARKET_SYMBOLS', 'ETHUSDT');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'mock=BTCUSDT@1h;mock=ETHUSDT@1h');

        const { marketProviderFor } = await import('./market.provider');

        // The claim this file did not have a test for, and the reason the
        // per-market cycle needed one: routing decides *which venue* answers and
        // used to ignore *which market* it answers for. The provider was built
        // with `marketConfig.symbol`, so `marketProviderFor('ETHUSDT')` returned
        // something that reported ETHUSDT's venue and served BTC candles. The
        // capability table said the venue served ETHUSDT; the venue disagreed.
        //
        // Asserted through `getPrice`, which is where the symbol shows up in the
        // answer, rather than through the provider's fields — a provider that
        // holds the right string and ignores it would pass a field check.
        const eth = await marketProviderFor('ETHUSDT').getPrice();

        expect(eth.symbol).toBe('ETHUSDT');

        const btc = await marketProviderFor('BTCUSDT').getPrice();

        expect(btc.symbol).toBe('BTCUSDT');
    });

    it('keeps the two markets on separate venues', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');
        vi.stubEnv('MARKET_SYMBOLS', 'ETHUSDT');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'mock=BTCUSDT@1h;mock=ETHUSDT@1h');

        const { marketProviderFor } = await import('./market.provider');

        // A cache keyed by venue alone would pass the test above — both markets
        // are served by `mock`, so a shared instance answers whichever symbol it
        // was built with and the mismatch check downstream would refuse the
        // other one. Distinct instances is the requirement.
        expect(marketProviderFor('ETHUSDT')).not.toBe(marketProviderFor('BTCUSDT'));
    });
});

describe('the venue a market is stored under', () => {
    it('is the venue configured to serve that market, not the primary', async () => {
        // **This is the item.** `configuredSeries` took its provider from
        // `marketConfig.provider` — the venue for the market named by
        // `marketConfig.symbol` and for no other. So a market configured to be
        // served by a different venue was stored under the primary's name, in
        // five tables at once: candles, signal history, signal state,
        // transitions and outcomes all attributed one venue's prices to another,
        // with no join anywhere able to contradict it.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_SYMBOL', 'BTCUSDT');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=ETHUSDT@1h');

        const { configuredVenueFor } = await import('./market.provider');

        expect(configuredVenueFor('BTCUSDT')).toBe('binance');
        expect(configuredVenueFor('ETHUSDT')).toBe('bitget');
    });

    it('is stable while the answering venue is not', async () => {
        // The reason this is the *configured* venue and not the one that
        // answered. Under failover the answering venue changes between fetches,
        // so a series key built from it would split one market's bars across two
        // series every time the primary failed over — the same hour filed twice,
        // under a venue that did not serve it.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=BTCUSDT@1h');

        const { configuredVenueFor, marketProviderFor } = await import('./market.provider');

        // The primary with failover is served by a **chain**, and the chain's own
        // name is `failover` — not a venue. So there is nothing here to derive a
        // storage key from even if someone wanted to: the object that fetches has
        // no single venue identity, and the venue that answered is a property of
        // one fetch rather than of the market.
        expect(marketProviderFor('BTCUSDT').name).toBe('failover');
        expect(configuredVenueFor('BTCUSDT')).toBe('binance');
    });

    it('refuses a market no venue serves instead of naming the primary', async () => {
        // A key that silently names the wrong venue is worse than a refusal: it
        // writes. Rows land in a plausible series, the gaps disappear, and every
        // later read of that series is a read of another asset.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h');

        const { configuredVenueFor } = await import('./market.provider');

        // Synchronous, so `rejects` would be the wrong form: there is no promise to
        // reject, the call throws before one exists. `marketProviderFor` throws
        // the same way and for the same reason.
        expect(() => configuredVenueFor('ETHUSDT')).toThrow(/ETHUSDT/);
    });
});
