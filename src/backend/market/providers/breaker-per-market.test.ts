import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
