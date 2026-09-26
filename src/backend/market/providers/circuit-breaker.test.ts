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
});
