/**
 * A plain consecutive-failure breaker.
 *
 * Its purpose is not to make a failing provider fail differently — it still
 * fails. The purpose is to stop the application from *hammering* an upstream
 * that has already said no. Every rejected call costs a socket, adds latency
 * to a request that is going to fail anyway, and can turn a short outage into
 * a rate-limit ban. Opening the breaker turns that traffic into an immediate,
 * honest refusal that the snapshot cache can cover with the last good read.
 *
 * After the cooldown one request is let through as a probe. If it succeeds the
 * breaker closes; if it fails the cooldown starts again.
 */
export interface CircuitBreakerOptions {
    failureThreshold: number;
    cooldownMs: number;
    now?: () => number;
}

export type CircuitBreakerState = 'closed' | 'open' | 'probing';

export class CircuitBreaker {
    #failureThreshold: number;
    #cooldownMs: number;
    #now: () => number;

    #consecutiveFailures = 0;
    #openUntil = 0;
    #probeInFlight = false;

    constructor(options: CircuitBreakerOptions) {
        this.#failureThreshold = options.failureThreshold;
        this.#cooldownMs = options.cooldownMs;
        // Wrapped rather than captured so the clock is read at call time; a
        // captured `Date.now` would keep using the original global.
        this.#now = options.now ?? (() => Date.now());
    }

    get state(): CircuitBreakerState {
        if (this.#consecutiveFailures < this.#failureThreshold) {
            return 'closed';
        }

        return this.#openUntil > this.#now() ? 'open' : 'probing';
    }

    /** Milliseconds left before a request is attempted again. */
    get retryAfterMs(): number {
        return this.state === 'probing'
            ? 0
            : Math.max(0, this.#openUntil - this.#now());
    }

    /**
     * Reserves the right to make one request. Reserving (rather than merely
     * asking) is what keeps a burst from all becoming probes at the same
     * moment when the cooldown elapses.
     */
    tryAcquire(): boolean {
        if (this.state === 'closed') {
            return true;
        }

        if (this.state === 'open') {
            return false;
        }

        // The cooldown has elapsed and the breaker is probing: let exactly one
        // caller through. Reserving it here (rather than merely asking) is
        // what keeps a burst from all becoming probes at the same moment.
        if (this.#probeInFlight) {
            return false;
        }

        this.#probeInFlight = true;

        return true;
    }

    recordSuccess(): void {
        this.#consecutiveFailures = 0;
        this.#openUntil = 0;
        this.#probeInFlight = false;
    }

    recordFailure(): void {
        this.#consecutiveFailures += 1;
        this.#probeInFlight = false;

        if (
            this.#consecutiveFailures >= this.#failureThreshold &&
            this.#openUntil <= this.#now()
        ) {
            this.#openUntil = this.#now() + this.#cooldownMs;
        }
    }

    /**
     * Opens the breaker for a window the provider itself dictated, such as a
     * `Retry-After` on a rate-limit response. Obeying it as a refusal is
     * better than obeying it as a sleep: the request ends immediately and the
     * caller falls back to cached data.
     */
    openFor(ms: number): void {
        this.#consecutiveFailures = Math.max(
            this.#consecutiveFailures,
            this.#failureThreshold,
        );
        this.#openUntil = Math.max(this.#openUntil, this.#now() + ms);
    }

    reset(): void {
        this.#consecutiveFailures = 0;
        this.#openUntil = 0;
        this.#probeInFlight = false;
    }
}
