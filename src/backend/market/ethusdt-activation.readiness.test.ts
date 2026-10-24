import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The ETHUSDT activation rehearsal: the one deployment `.env.example` documents
 * for adding a second market, booted whole, with every operator-facing answer
 * asserted in one place.
 *
 * Each layer already has its own suite — the boot refusals in
 * `market.config.test.ts`, routing and storage keys in
 * `market.provider.test.ts`, the cache in `market-isolation.test.ts`. What none
 * of them rehearses is the *composition*: the exact settings an operator writes
 * on activation day, read by the real config graph, and the complete picture
 * those settings produce. A refactor that satisfies every layer suite while
 * breaking how the layers compose fails here, before the deployment does.
 */
describe('the ETHUSDT activation rehearsal', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    /** The env diff `docs/ethusdt-activation.md` tells an operator to write. */
    const activationEnv = (): void => {
        vi.stubEnv('MARKET_PROVIDER', 'binance');
        vi.stubEnv('MARKET_FALLBACK_PROVIDERS', 'bitget');
        vi.stubEnv('MARKET_SYMBOL', 'BTCUSDT');
        vi.stubEnv('MARKET_SYMBOLS', 'ETHUSDT');
        vi.stubEnv(
            'MARKET_VENUE_CAPABILITIES',
            'binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT,ETHUSDT@1h',
        );
    };

    it('boots the documented second-market deployment and answers as an operator would check it', async () => {
        activationEnv();

        // The config reads the environment once, at module load, and every
        // refusal in `market.runtime.ts` runs on that load. Reaching these
        // imports at all means the activation refusals accepted the settings:
        // both markets resolvable, both declared at the configured interval,
        // and the declared backup still serving the primary market.
        const { marketConfig } = await import('../config/market.config');
        const {
            configuredVenueFor,
            marketProviderFor,
            venuesServing,
        } = await import('./market.provider');

        expect(marketConfig.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
        expect(
            marketConfig.venueCapabilities.map((entry) => entry.venue),
        ).toEqual(['binance', 'bitget']);

        // Every declared venue serves both markets at the configured interval —
        // the property `venuesServing` asks before a market enters a chain, here
        // read for both markets rather than one.
        expect(venuesServing('BTCUSDT')).toEqual(['binance', 'bitget']);
        expect(venuesServing('ETHUSDT')).toEqual(['binance', 'bitget']);

        // Each market gets its own chain — its own breaker, its own recovery —
        // and asking twice hands back the same chain, because a rebuilt one
        // would forget which venue just timed out.
        const btc = marketProviderFor('BTCUSDT');
        const eth = marketProviderFor('ETHUSDT');

        expect(btc.name).toBe('failover');
        expect(eth.name).toBe('failover');
        expect(eth).toBe(marketProviderFor('ETHUSDT'));
        expect(eth).not.toBe(btc);

        // The series key names the *configured* venue, stable across failover.
        // With both venues declaring both markets, binance leads both chains and
        // both series are filed under it; bitget is the backup either may run on.
        expect(configuredVenueFor('BTCUSDT')).toBe('binance');
        expect(configuredVenueFor('ETHUSDT')).toBe('binance');
    });
});
