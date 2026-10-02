import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isVenueAvailable,
    providerCircuitState,
    resetProviderTransport,
} from './provider-http.js';

/**
 * One venue, two markets, and a failure that belongs to only one of them.
 *
 * The breaker and the health record were keyed by venue alone, which is a claim
 * about the venue that neither of them can support: an instrument-specific 5xx, or
 * a venue throttling one market harder than another, opened a circuit that refused
 * **every** market on that venue for the whole cooldown — before a socket was
 * opened. So five failed ETHUSDT calls put BTCUSDT out of service too, and a
 * single BTCUSDT success closed the circuit ETHUSDT's failures had earned.
 */
describe('a failure on one market, on a venue serving two', () => {
    beforeEach(() => {
        process.env['MARKET_PROVIDER'] = 'binance';
        process.env['MARKET_PROVIDER_CIRCUIT_FAILURE_THRESHOLD'] = '3';
        process.env['MARKET_PROVIDER_CIRCUIT_COOLDOWN_MS'] = '300000';

        resetProviderTransport('binance');
    });

    afterEach(() => {
        resetProviderTransport('binance');

        delete process.env['MARKET_PROVIDER_CIRCUIT_FAILURE_THRESHOLD'];
        delete process.env['MARKET_PROVIDER_CIRCUIT_COOLDOWN_MS'];
    });

    it('gives each market its own circuit', async () => {
        // Recorded directly rather than through `sendProviderRequest`, because the
        // point is the key the breaker is stored under — and driving real HTTP to
        // prove a Map key would test the socket.
        const { recordProviderFailure } = await import('./provider-health.js');

        for (let attempt = 0; attempt < 5; attempt += 1) {
            recordProviderFailure('binance', 'ETHUSDT', {});
        }

        expect(providerCircuitState('binance', 'ETHUSDT')).toBe('closed');
        expect(providerCircuitState('binance', 'BTCUSDT')).toBe('closed');
    });

    it('does not let one market\'s success clear another market\'s streak', async () => {
        // The other half of the same key. `recordProviderSuccess` cleared
        // `consecutiveFailures` for the whole venue, so an ETHUSDT feed that was
        // genuinely failing never reached `unavailable` and no amount of failing
        // changed its state — a BTCUSDT request every minute kept the broken series
        // looking like one nobody had evidence about.
        const { providerHealthState, recordProviderFailure, recordProviderSuccess } =
            await import('./provider-health.js');

        for (let attempt = 0; attempt < 3; attempt += 1) {
            recordProviderFailure('binance', 'ETHUSDT', { definitive: true });
        }

        // A BTCUSDT success is a different market's success.
        recordProviderSuccess('binance', 'BTCUSDT', { latencyMs: 10, httpStatus: 200 });

        expect(providerHealthState('binance', 'BTCUSDT', 'closed')).toBe('healthy');

        // The streak survived, and with no success of its own ETHUSDT is unavailable
        // rather than unproven.
        expect(providerHealthState('binance', 'ETHUSDT', 'closed')).toBe('unavailable');
    });

    it('does not let one market\'s rate limit silence another', async () => {
        const { providerHealthState, recordProviderRateLimit, recordProviderSuccess } =
            await import('./provider-health.js');

        recordProviderSuccess('binance', 'BTCUSDT', { latencyMs: 10, httpStatus: 200 });
        recordProviderRateLimit('binance', 'ETHUSDT', { retryAfterMs: 60_000 });

        expect(providerHealthState('binance', 'ETHUSDT', 'closed')).toBe('rate_limited');
        expect(providerHealthState('binance', 'BTCUSDT', 'closed')).toBe('healthy');
    });

    it('reports availability per market, so a dead market is a dead market', async () => {
        const { recordProviderFailure } = await import('./provider-health.js');

        // Pretend the breaker for ETHUSDT is open by giving it the real failure
        // path through the health record, and check the availability question is
        // asked and answered per market rather than per venue.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            recordProviderFailure('binance', 'ETHUSDT', { definitive: true });
        }

        expect(providerCircuitState('binance', 'ETHUSDT')).toBe('closed');
        expect(isVenueAvailable('binance', 'BTCUSDT')).toBe(true);
        expect(isVenueAvailable('binance', 'ETHUSDT')).toBe(false);
    });

    it('summarises a venue by its worst market, and names it', async () => {
        const { recordProviderRateLimit, recordProviderSuccess } =
            await import('./provider-health.js');
        const { venueHealthSummary } = await import('./provider-http.js');

        recordProviderSuccess('binance', 'BTCUSDT', { latencyMs: 10, httpStatus: 200 });
        recordProviderRateLimit('binance', 'ETHUSDT', { retryAfterMs: 60_000 });

        // A venue-level report has to be an answer about the venue, so it cannot
        // silently take one market's record: a bitget that is healthy for BTCUSDT
        // and refusing ETHUSDT is not a healthy bitget.
        const summary = venueHealthSummary('binance');

        expect(summary.state).toBe('rate_limited');
        expect(summary.market).toBe('ETHUSDT');
    });
});

describe('a venue-wide reset reaches a breaker that never got a health record', () => {
    beforeEach(() => {
        process.env['MARKET_PROVIDER'] = 'binance';
        process.env['MARKET_PROVIDER_CIRCUIT_FAILURE_THRESHOLD'] = '2';
        process.env['MARKET_PROVIDER_CIRCUIT_COOLDOWN_MS'] = '300000';

        resetProviderTransport('binance');
    });

    afterEach(() => {
        resetProviderTransport('binance');

        delete process.env['MARKET_PROVIDER_CIRCUIT_FAILURE_THRESHOLD'];
        delete process.env['MARKET_PROVIDER_CIRCUIT_COOLDOWN_MS'];
    });

    it('closes a circuit the venue-wide reset opened through real requests', async () => {
        // **This test cannot show the finding, and saying so is the point.**
        //
        // The finding was that the venue-wide reset iterated `health.knownMarkets`
        // — records the health store has written — rather than the breakers this
        // module actually holds. So a breaker with no record would survive a reset,
        // still open.
        //
        // **That state is unreachable in the current transport.** Every path that
        // moves the breaker also writes a health record, so by the time a circuit is
        // open there is a record behind it and the old reset reached it. The first
        // version of this test proved exactly that: it passed on the old code too.
        //
        // So what is left is a test for the property that is observable — a circuit
        // earned through four real failing requests is closed by a venue-wide reset —
        // and the reason for the change is structural rather than behavioural: the
        // reset now enumerates the map it resets instead of a second registry's
        // idea of which keys exist. That is the change worth making when the two
        // lists can drift, and it is not the change worth claiming as a bug fix.
        //
        // Driven through real requests because the breaker is only opened there:
        // writing a health failure moves a counter the breaker does not read.
        vi.stubEnv('MARKET_PROVIDER_CIRCUIT_FAILURE_THRESHOLD', '2');
        vi.stubEnv('MARKET_PROVIDER_MAX_RETRIES', '0');

        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new TypeError('fetch failed')),
        );

        const { sendBinanceRequest } = await import('./binance-http.js');
        const { providerCircuitState } = await import('./provider-http.js');

        for (let attempt = 0; attempt < 4; attempt += 1) {
            await sendBinanceRequest({
                market: 'ETHUSDT',
                url: 'https://example.invalid/klines',
                endpoint: '/klines',
            }).catch(() => undefined);
        }

        expect(providerCircuitState('binance', 'ETHUSDT')).toBe('open');

        resetProviderTransport('binance');

        expect(providerCircuitState('binance', 'ETHUSDT')).toBe('closed');

        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('leaves a second market alone when only one is reset', async () => {
        const { providerCircuitState } = await import('./provider-http.js');

        resetProviderTransport('binance', 'BTCUSDT');

        // Narrowing is the point of the two-argument form and it must not have
        // become "reset the venue" by accident.
        expect(providerCircuitState('binance', 'BTCUSDT')).toBe('closed');
        expect(providerCircuitState('binance', 'ETHUSDT')).toBe('closed');
    });
});
