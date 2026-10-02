import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { availableVenues } = vi.hoisted(() => ({
    // A set of venues that are up. Everything else is down, which is what a
    // circuit-opened venue looks like to this question.
    availableVenues: new Set<string>(),
}));

vi.mock('./providers/provider-http.js', () => ({
    // Only this import is used by `market.provider`, so the module does not have to
    // be reproduced in full — and reproducing it in full would be a second copy of
    // the health logic, which is exactly the thing being avoided.
    isVenueAvailable: (venue: string) => availableVenues.has(venue),
}));

describe('is a venue that cannot serve this market evidence that it can', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h');
        vi.stubEnv('MARKET_PROVIDER_CIRCUIT_FAILURE_THRESHOLD', '1');
        vi.stubEnv('MARKET_PROVIDER_CIRCUIT_COOLDOWN_MS', '300000');

        availableVenues.clear();
        availableVenues.add('binance');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('reports the second market dead when only a foreign venue is up', async () => {
        // **This is the item.** binance is up and serves BTCUSDT; bitget serves
        // ETHUSDT and is down. The old question was "is any configured venue
        // available", so this answered yes — and a cache hit for ETHUSDT was
        // labelled `fresh` with `X-Data-Stale: false` while the only venue trading
        // ETHUSDT was refusing.
        //
        // `provider_failed` exists for precisely that case and was unreachable for
        // every market but one.
        const { anyMarketProviderAvailable } = await import('./market.provider');

        expect(anyMarketProviderAvailable('ETHUSDT')).toBe(false);
        expect(anyMarketProviderAvailable('BTCUSDT')).toBe(true);
    });

    it('reports the second market alive once its own venue answers', async () => {
        availableVenues.add('bitget');

        const { anyMarketProviderAvailable } = await import('./market.provider');

        expect(anyMarketProviderAvailable('ETHUSDT')).toBe(true);
    });

    it('reports nothing available when every venue is down', async () => {
        availableVenues.clear();

        const { anyMarketProviderAvailable } = await import('./market.provider');

        // The case the old process-wide question did answer correctly, and it is
        // kept here so the fix cannot regress into "always false".
        expect(anyMarketProviderAvailable('BTCUSDT')).toBe(false);
        expect(anyMarketProviderAvailable('ETHUSDT')).toBe(false);
    });

    it('does not count a venue that does not declare the market, even if it is up', async () => {
        // binance is up here and serves only BTCUSDT. For ETHUSDT it is not an
        // option, so it cannot vouch for ETHUSDT's feed — a capacity to answer is
        // not a commitment to answer *this*.
        const { venuesServing } = await import('./market.provider');

        // **The backup serves the primary market, and that is now required.** It
        // used to be an assertion the config could not satisfy together with a
        // declared backup: a backup that does not serve the primary is exactly what
        // the round-104 finding was — a chain entry that answers another market. So
        // the table gives bitget both, and the lesson moved to the second line,
        // where binance is up, serves BTCUSDT, and is still not an option for
        // ETHUSDT. A capacity to answer is not a commitment to answer *this*.
        expect(venuesServing('BTCUSDT')).toEqual(['binance', 'bitget']);
        expect(venuesServing('ETHUSDT')).toEqual(['bitget']);
    });
});
