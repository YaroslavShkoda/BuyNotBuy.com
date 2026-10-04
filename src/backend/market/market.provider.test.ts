import { afterEach, describe, expect, it, vi } from 'vitest';

import { FailoverProvider } from './failover.provider.js';

/**
 * Cleanup in a hook, not at the end of each test.
 *
 * `vi.unstubAllEnvs()` was the last statement of every test, which means a test
 * that threw left its environment stubbed and the next test inherited it. The
 * round-96 boot check turned that into a visible failure — a test that named
 * `MARKET_SYMBOLS` for one case made the next one refuse to load — but the leak
 * was there before it, invisible, and only now had a symptom.
 *
 * The same shape as the `mockClear()` in the signal-history suite: cleanup in
 * the body is cleanup that a failure skips.
 */
afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

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

    });

    it('names the primary while it is healthy', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');

        const { activeMarketVenue, configuredMarketVenues } = await import(
            './market.provider'
        );

        expect(activeMarketVenue()).toBe('binance');
        expect(configuredMarketVenues()).toEqual(['binance', 'bitget']);

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
        // bitget declares the primary market as well as the routed one: it is
        // listed in `MARKET_FALLBACK_PROVIDERS`, and the round-104 check refuses a
        // configured backup that cannot serve the primary market.
        vi.stubEnv(
            'MARKET_VENUE_CAPABILITIES',
            'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h',
        );

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
        // No backup, stated rather than left to the default: with the default
        // `MARKET_FALLBACK_PROVIDERS=bitget` and no declaration for bitget, the
        // round-104 boot check refuses the config before this ever runs. Which is
        // correct — but it would be refusing about a different thing than the one
        // this test is named after.
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', '');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h');

        const { configuredVenueFor } = await import('./market.provider');

        // Synchronous, so `rejects` would be the wrong form: there is no promise to
        // reject, the call throws before one exists. `marketProviderFor` throws
        // the same way and for the same reason.
        expect(() => configuredVenueFor('ETHUSDT')).toThrow(/ETHUSDT/);
    });
});

describe('failover for a market that is not the primary', () => {
    /**
     * With `MARKET_FALLBACK_PROVIDERS=bitget` and bitget declaring ETHUSDT, the
     * second market used to be served by a bare venue: `FailoverProvider` was
     * built once, for the process, around the primary market. So the setting
     * exists because a primary venue is unreachable from some networks, and it
     * did nothing for every market but one.
     */
    it('gives a routed market a chain instead of a bare venue', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        // bitget declares the primary market as well as the routed one: it is
        // listed in `MARKET_FALLBACK_PROVIDERS`, and the round-104 check refuses a
        // configured backup that cannot serve the primary market.
        vi.stubEnv(
            'MARKET_VENUE_CAPABILITIES',
            'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h',
        );

        const { marketProviderFor } = await import('./market.provider');

        const eth = marketProviderFor('ETHUSDT');

        // Bitget is the only venue declaring ETHUSDT, so the chain is one long.
        // The claim is not "there is a chain" but "there is something to fail
        // over to" — asserted on the venue list, which is what a failover would
        // actually walk.
        expect(eth.name).toBe('failover');
        expect((eth as FailoverProvider).venues).toEqual(['bitget']);
    });

    it('keeps a declared backup in the chain, in configured preference order', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h');

        const { marketProviderFor } = await import('./market.provider');

        // Both declare ETHUSDT, so both are in the chain — and the routed venue
        // leads, because it is the one `route()` picked for this market.
        expect((marketProviderFor('ETHUSDT') as FailoverProvider).venues).toEqual([
            'binance',
            'bitget',
        ]);
    });

    it('excludes a backup that does not declare the market', async () => {
        // **The half that makes the chain safe.** `FailoverProvider` asks each
        // venue in order and never checks what that venue serves, so an
        // unfiltered chain would fail over from a dead ETHUSDT venue to one that
        // does not trade ETHUSDT. Nothing inside the chain would notice; the only
        // thing between that and one asset's prices filed under another's name is
        // a symbol check further downstream.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT@1h');

        const { marketProviderFor } = await import('./market.provider');

        // Bitget does not declare ETHUSDT, so the chain for ETHUSDT is binance
        // alone — and a chain of one is honest: there is nowhere to go.
        expect((marketProviderFor('ETHUSDT') as FailoverProvider).venues).toEqual(['binance']);

        // The mirror image, so the exclusion is not "the second entry is always
        // dropped": for BTCUSDT, bitget is a declared backup.
        expect((marketProviderFor('BTCUSDT') as unknown as FailoverProvider).venues).toEqual([
            'binance',
            'bitget',
        ]);
    });

    it('keeps one chain per market, so its breaker and recovery survive between calls', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        // bitget declares the primary market as well as the routed one: it is
        // listed in `MARKET_FALLBACK_PROVIDERS`, and the round-104 check refuses a
        // configured backup that cannot serve the primary market.
        vi.stubEnv(
            'MARKET_VENUE_CAPABILITIES',
            'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h',
        );

        const { marketProviderFor } = await import('./market.provider');

        // A fresh chain per request would reset the circuit breaker every time —
        // so it could never stay open — and the recovery counter every time, so
        // it could never complete. Both of those are the reason a chain exists.
        expect(marketProviderFor('ETHUSDT')).toBe(marketProviderFor('ETHUSDT'));
        expect(marketProviderFor('ETHUSDT')).not.toBe(marketProviderFor('BTCUSDT'));
    });
});

describe('a venue switch that names its market', () => {
    it('reports the switch of the market it was asked about, not the process one', async () => {
        // The second half of the item. The watcher used to be one for the whole
        // process, reading the process-wide chain — which is the primary market's.
        // So a switch on any other market was invisible, and a switch on the
        // primary produced a line naming no market at all.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h');

        const { activeVenueForMarket, createVenueWatcher } = await import('./market.provider');

        const warn = vi.fn();
        const info = vi.fn();

        let venue = 'binance';

        const report = createVenueWatcher(
            { warn, info },
            () => venue,
            'binance',
            'ETHUSDT',
        );

        // The first observation is the process starting, not a failover.
        report();
        expect(warn).not.toHaveBeenCalled();

        venue = 'bitget';
        report();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toMatchObject({
            event: 'market_venue_switched',
            from: 'binance',
            to: 'bitget',
            // The market is the whole difference between a readable line and two
            // identical ones when two venues change at once.
            market: 'ETHUSDT',
        });

        expect(activeVenueForMarket('ETHUSDT')).toBe('binance');
    });

    it('does not report a change for a market that did not change', async () => {
        // Two markets sitting on the same venue is not a change for either of
        // them. A process-wide `last` would call the second one's report a
        // switch, because the first one's watch had already been updated.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h');

        const { createVenueWatcher } = await import('./market.provider');

        const warn = vi.fn();
        const info = vi.fn();

        const btc = createVenueWatcher({ warn, info }, () => 'binance', 'binance', 'BTCUSDT');
        const eth = createVenueWatcher({ warn, info }, () => 'binance', 'binance', 'ETHUSDT');

        btc();
        eth();
        btc();
        eth();

        // No switches happened, so `warn` was never called — only the two
        // "process starting" lines at info level.
        expect(warn).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(2);
    });
});

describe('the process-wide chain cannot carry another market', () => {
    it('puts only the venues that serve this market in the chain', async () => {
        // **This is the finding.** The chain used to ask each backup for "its own
        // configured ticker", so with `MARKET_SYMBOL=BTCUSDT` and
        // `MARKET_FALLBACK_SYMBOL=ETHUSDT` it became `[binance:BTCUSDT,
        // bitget:ETHUSDT]` — the moment binance opened, BTCUSDT was served by a
        // venue answering ETHUSDT.
        //
        // No wrong price was stored: `market.service.ts` compares the symbol it was
        // handed against the request and refuses. The failure was a 503 naming
        // ETHUSDT on a BTCUSDT request, and the operator's first guess would have
        // been the wrong venue.
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=BTCUSDT@1h');

        const { marketDataProvider } = await import('./market.provider');

        expect((marketDataProvider as FailoverProvider).venues).toEqual([
            'binance',
            'bitget',
        ]);
    });

});
