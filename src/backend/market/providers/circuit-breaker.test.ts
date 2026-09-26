import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from './circuit-breaker.js';

function breakerWith(
    failureThreshold: number,
    cooldownMs: number,
    now: () => number,
) {
    return new CircuitBreaker({ failureThreshold, cooldownMs, now });
}

describe('CircuitBreaker', () => {
    it('stays closed and admits requests below the threshold', () => {
        const breaker = breakerWith(3, 1000, () => 0);

        for (let index = 0; index < 2; index += 1) {
            expect(breaker.state).toBe('closed');
            expect(breaker.tryAcquire()).toBe(true);
            breaker.recordFailure();
        }

        expect(breaker.state).toBe('closed');
    });

    it('opens once the threshold is reached and refuses immediately', () => {
        const breaker = breakerWith(3, 1000, () => 0);

        for (let index = 0; index < 3; index += 1) {
            breaker.tryAcquire();
            breaker.recordFailure();
        }

        expect(breaker.state).toBe('open');
        expect(breaker.tryAcquire()).toBe(false);
        expect(breaker.retryAfterMs).toBe(1000);
    });

    it('a single success closes it again', () => {
        const breaker = breakerWith(1, 1000, () => 0);

        breaker.recordFailure();
        expect(breaker.state).toBe('open');

        breaker.recordSuccess();

        expect(breaker.state).toBe('closed');
        expect(breaker.retryAfterMs).toBe(0);
        expect(breaker.tryAcquire()).toBe(true);
    });

    it('lets exactly one request through as a probe after the cooldown', () => {
        let now = 0;
        const breaker = breakerWith(1, 1000, () => now);

        breaker.recordFailure();
        expect(breaker.tryAcquire()).toBe(false);

        now = 1001;
        expect(breaker.state).toBe('probing');
        expect(breaker.tryAcquire()).toBe(true);
        // The rest of the burst is held back: otherwise every waiting caller
        // would hit a provider that only just started failing again.
        expect(breaker.tryAcquire()).toBe(false);

        breaker.recordSuccess();
        expect(breaker.tryAcquire()).toBe(true);
    });

    it('a failed probe restarts the cooldown', () => {
        let now = 0;
        const breaker = breakerWith(1, 1000, () => now);

        breaker.recordFailure();
        now = 1001;
        expect(breaker.tryAcquire()).toBe(true);

        breaker.recordFailure();

        expect(breaker.state).toBe('open');
        expect(breaker.retryAfterMs).toBe(1000);
    });

    it('openFor honours a longer server-dictated window and never shortens one', () => {
        let now = 0;
        const breaker = breakerWith(5, 1000, () => now);

        breaker.openFor(60_000);
        expect(breaker.retryAfterMs).toBe(60_000);

        // A later, shorter hint must not cut the wait we already promised.
        breaker.openFor(500);
        expect(breaker.retryAfterMs).toBe(60_000);

        now = 60_001;
        expect(breaker.state).toBe('probing');
    });

    it('reset clears both the counter and the window', () => {
        const breaker = breakerWith(1, 1000, () => 0);

        breaker.recordFailure();
        breaker.reset();

        expect(breaker.state).toBe('closed');
        expect(breaker.tryAcquire()).toBe(true);
    });

    it('admits exactly one probe out of a hundred arriving after the cooldown', () => {
        let now = 0;
        const breaker = breakerWith(1, 1000, () => now);

        breaker.recordFailure();
        now = 1001;

        // The hazard this guards: all hundred callers see 'probing' at the same
        // instant, and if the reservation were a read rather than a claim they
        // would all become probes and hammer a provider that had just started
        // failing again.
        let admitted = 0;

        for (let index = 0; index < 100; index += 1) {
            if (breaker.tryAcquire()) admitted += 1;
        }

        expect(admitted).toBe(1);
    });

    it('a rate limit landing on the probe does not silence the provider forever', () => {
        let now = 0;
        const breaker = breakerWith(1, 1000, () => now);

        breaker.recordFailure();
        now = 1001;

        // The probe goes upstream and is answered with a rate limit, which is
        // what sendProviderRequest does: openFor, then give up on the call.
        expect(breaker.tryAcquire()).toBe(true);
        breaker.openFor(60_000);

        expect(breaker.state).toBe('open');
        expect(breaker.retryAfterMs).toBe(60_000);
        expect(breaker.tryAcquire()).toBe(false);

        // The window the provider asked for is honoured...
        now += breaker.retryAfterMs + 1;

        // ...and then the provider is actually tried again. Without the flag
        // being released this is where it wedges: the state is 'probing' but the
        // reservation is still held, so the venue is never asked again.
        expect(breaker.state).toBe('probing');
        expect(breaker.tryAcquire()).toBe(true);
        expect(breaker.tryAcquire()).toBe(false);
    });

    it('a rate limit on an ordinary request leaves the next probe reachable', () => {
        let now = 0;
        const breaker = breakerWith(3, 1000, () => now);

        // Closed, so tryAcquire() never set the reservation — openFor must not
        // leave the breaker in a state where a later probe is impossible.
        expect(breaker.tryAcquire()).toBe(true);
        breaker.openFor(30_000);

        expect(breaker.state).toBe('open');
        expect(breaker.tryAcquire()).toBe(false);

        now += breaker.retryAfterMs + 1;
        expect(breaker.tryAcquire()).toBe(true);
    });
});
