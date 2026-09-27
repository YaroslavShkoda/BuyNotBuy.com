import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isProviderAvailable,
    knownProviders,
    providerHealth,
    providerHealthState,
    recordProviderFailure,
    recordProviderRateLimit,
    recordProviderSuccess,
    resetProviderHealth,
} from './provider-health.js';

import type { CircuitBreakerState } from './circuit-breaker.js';

const NOW = 1_700_000_000_000;

function at(offsetMs: number): number {
    return NOW + offsetMs;
}

describe('provider health model', () => {
    beforeEach(() => {
        resetProviderHealth();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('says degraded for a venue nobody has asked yet', () => {
        // Not `healthy`: nobody has any evidence. Not `unavailable` either —
        // nothing was tried, and a model that calls an untried venue broken
        // would report a cold process as a total outage.
        expect(providerHealthState('binance', 'closed', NOW)).toBe('degraded');
        expect(isProviderAvailable('binance', 'closed', NOW)).toBe(true);
    });

    it('moves from degraded to healthy after a recent success', () => {
        recordProviderSuccess('binance', { latencyMs: 120, httpStatus: 200 });

        expect(providerHealthState('binance', 'closed', NOW)).toBe('healthy');
    });

    it('calls a venue degraded once its last success is too old', () => {
        recordProviderSuccess('binance', { latencyMs: 120, httpStatus: 200 });

        // Silence is not health: a provider that stopped being called looks
        // exactly like one that answers instantly, and only the age of the last
        // answer separates them.
        expect(
            providerHealthState(
                'binance',
                'closed',
                at(300_001),
            ),
        ).toBe('degraded');
    });

    it('calls a venue that never succeeded and is failing unavailable', () => {
        recordProviderFailure('binance', { httpStatus: 503 });

        expect(providerHealthState('binance', 'closed', NOW)).toBe('unavailable');
        expect(isProviderAvailable('binance', 'closed', NOW)).toBe(false);
    });

    it('calls a venue that worked and is now failing recovering', () => {
        recordProviderSuccess('binance', { latencyMs: 100, httpStatus: 200 });
        recordProviderFailure('binance', { httpStatus: 500 });

        // Still worth asking: the circuit has not opened, and one failure after
        // a long run of successes is exactly when trying again is right.
        expect(providerHealthState('binance', 'closed', NOW)).toBe('recovering');
        expect(isProviderAvailable('binance', 'closed', NOW)).toBe(true);
    });

    it('lets the breaker override everything else', () => {
        recordProviderSuccess('binance', { latencyMs: 100, httpStatus: 200 });

        // A breaker that is open is a policy decision to stop calling, and it
        // outranks a record that still says the last call worked.
        expect(providerHealthState('binance', 'open', NOW)).toBe('circuit_open');
        expect(isProviderAvailable('binance', 'open', NOW)).toBe(false);
    });

    it('calls a half-open venue recovering rather than healthy', () => {
        recordProviderSuccess('binance', { latencyMs: 100, httpStatus: 200 });

        // The cooldown elapsed and a probe is about to run. Reporting `healthy`
        // here would claim the venue had been checked, when the whole point of
        // the state is that it has not been checked since it went dark.
        expect(providerHealthState('binance', 'probing', NOW)).toBe('recovering');
    });

    it('honours a rate-limit window only while it runs', () => {
        recordProviderRateLimit('binance', { retryAfterMs: 60_000, httpStatus: 429 });

        expect(providerHealthState('binance', 'closed', at(1_000))).toBe('rate_limited');
        expect(isProviderAvailable('binance', 'closed', at(1_000))).toBe(false);

        // The window expiring is the whole reason the state carries an end, and
        // it is the case that has to be right: a model that kept saying "rate
        // limited" after the window closed would silence a recovered venue for
        // the life of the process. A rate limit is a refusal with a known end,
        // so it deliberately does not count towards the failure streak — the
        // window and the breaker already enforce it, and counting it a third
        // time would leave a perfectly healthy venue off the roster for a
        // reason that expired.
        expect(providerHealthState('binance', 'closed', at(60_001))).toBe('degraded');
        expect(isProviderAvailable('binance', 'closed', at(60_001))).toBe(true);
    });

    it('returns a venue to healthy after a success that followed a rate limit', () => {
        recordProviderRateLimit('binance', { retryAfterMs: 30_000, httpStatus: 429 });

        expect(providerHealthState('binance', 'closed', at(1_000))).toBe('rate_limited');

        recordProviderSuccess('binance', { latencyMs: 80, httpStatus: 200 });

        expect(providerHealthState('binance', 'closed', at(40_000))).toBe('healthy');
    });

    it('clears the failure streak on success', () => {
        recordProviderFailure('binance', { httpStatus: 500 });
        recordProviderFailure('binance', { httpStatus: 500 });
        recordProviderSuccess('binance', { latencyMs: 90, httpStatus: 200 });

        const snapshot = providerHealth('binance', 'closed', NOW);

        expect(snapshot.consecutiveFailures).toBe(0);
        expect(snapshot.lastLatencyMs).toBe(90);
        expect(snapshot.lastHttpStatus).toBe(200);
    });

    it('reports the remaining rate-limit wait, and zero once it is over', () => {
        recordProviderRateLimit('binance', { retryAfterMs: 30_000, httpStatus: 429 });

        expect(providerHealth('binance', 'closed', at(10_000)).retryAfterMs).toBe(20_000);
        expect(providerHealth('binance', 'closed', at(40_000)).retryAfterMs).toBe(0);
    });

    it('keeps venues independent', () => {
        recordProviderSuccess('binance', { latencyMs: 50, httpStatus: 200 });
        recordProviderFailure('bitget', { httpStatus: 500 });
        recordProviderFailure('bitget', { httpStatus: 500 });

        // One venue going dark must not move the other's verdict. A shared
        // record is how a primary outage ends up reported as a total one.
        expect(providerHealthState('binance', 'closed', NOW)).toBe('healthy');
        expect(providerHealthState('bitget', 'closed', NOW)).toBe('unavailable');
    });

    it('forgets only the venue asked to be forgotten', () => {
        recordProviderFailure('binance', { httpStatus: 500 });
        recordProviderFailure('bitget', { httpStatus: 500 });

        resetProviderHealth('binance');

        // Resetting one venue's transport state must not also erase the
        // evidence that a different venue is still down — that is a state the
        // production code can reach and a test must not manufacture for it.
        expect(knownProviders()).toEqual(['bitget']);
        expect(providerHealthState('bitget', 'closed', NOW)).toBe('unavailable');
    });

    it('works out the state from a circuit value it was given', () => {
        // The health model never reads a breaker itself; it is handed the state.
        // Pinned here so that decoupling does not quietly become "the parameter
        // is ignored" — and specifically so a venue with no record of its own
        // still reports an open circuit rather than being short-circuited to
        // "degraded" before the check that matters.
        const circuit: CircuitBreakerState = 'open';

        expect(providerHealthState('bitget', circuit, NOW)).toBe('circuit_open');
    });
});
