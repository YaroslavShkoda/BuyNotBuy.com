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
interface CircuitBreakerOptions {
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

    /**
     * Gives up a probe reservation without reporting an outcome.
     *
     * Needed for a probe whose caller walked away — a shutdown, a client that
     * navigated away mid-request. Nothing in the venue's control will ever
     * release that reservation, and because the state is `probing` for as long
     * as it is held, every later probe is refused and the venue is never asked
     * again for the life of the process. A healthy backup, silenced by a
     * deploy.
     *
     * The reservation is a single boolean, so "ownership" is not something
     * this can check: a caller that was refused may still call this, and would
     * clear a reservation it does not hold. So it is deliberately *not* safe to
     * call unless you were told you were admitted — which is why the transport
     * calls it only on the branch where `tryAcquire` returned true.
     */
    releaseProbe(): void {
        this.#probeInFlight = false;
    }

    recordSuccess(): void {
        this.#consecutiveFailures = 0;
        this.#openUntil = 0;
        this.#probeInFlight = false;
    }

    /**
     * Records one failed attempt of a request that is still running.
     *
     * Separate from `recordFailure` because a request may retry, and the two
     * things a failure does are not the same thing. Counting and opening are
     * about the venue; releasing the probe reservation is about *this request
     * being over*, and it happens on the last attempt only.
     *
     * Conflating them reopens the venue between two attempts of the same
     * request. The probe is sleeping out a backoff, the flag has been cleared,
     * and the next caller in the burst walks straight in — which is a burst
     * arriving at a venue that just refused, one request per backoff gap.
     */
    recordAttemptFailure(): void {
        this.#consecutiveFailures += 1;

        if (
            this.#consecutiveFailures >= this.#failureThreshold &&
            this.#openUntil <= this.#now()
        ) {
            this.#openUntil = this.#now() + this.#cooldownMs;
        }
    }

    recordFailure(): void {
        this.recordAttemptFailure();
        this.#probeInFlight = false;
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

        // Releases the probe reservation, and this is load-bearing rather than
        // tidiness. A rate limit can arrive on the probe request itself, and
        // that call is over — it got a definitive answer. Leaving the flag set
        // would strand it: the state is 'open' while the window runs, so nothing
        // consults the flag, and the moment the window expires the state is
        // 'probing' again with the flag still held. Every later probe is then
        // refused forever and the venue is never asked again for the life of the
        // process — a rate limit that expired ten minutes ago permanently silences
        // a provider that is now perfectly healthy.
        this.#probeInFlight = false;
    }

    reset(): void {
        this.#consecutiveFailures = 0;
        this.#openUntil = 0;
        this.#probeInFlight = false;
    }
}
