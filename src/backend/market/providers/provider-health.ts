import { marketConfig } from '../../config/market.config.js';

import type { CircuitBreakerState } from './circuit-breaker.js';

/**
 * What this application currently believes about one venue.
 *
 * Six states, derived rather than assigned: a call site reports what happened,
 * and the state is worked out from that plus the clock. Deriving it in one place
 * is what makes the answer to "can we get a live price right now" the same
 * everywhere, which is the whole point of having a health model at all — three
 * call sites each rolling their own notion of "down" is how a dashboard ends up
 * serving a five-minute-old price from a venue that has been refusing for an
 * hour without anybody noticing.
 */
export type ProviderHealthState =
    /** Answered recently, no failures since. */
    | 'healthy'
    /** Answered, but not for a while. Suspect, not broken. */
    | 'degraded'
    /** Refusing with a rate limit for a known remaining window. */
    | 'rate_limited'
    /** Failing, and has never once succeeded. */
    | 'unavailable'
    /** The breaker is refusing calls on purpose. */
    | 'circuit_open'
    /** Worked before and is failing now. */
    | 'recovering';

export interface ProviderHealthSnapshot {
    provider: string;
    state: ProviderHealthState;
    circuit: CircuitBreakerState;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    consecutiveFailures: number;
    lastLatencyMs: number | null;
    lastHttpStatus: number | null;
    retryAfterMs: number | null;
    /**
     * Whether it is worth asking this venue for a live price.
     *
     * False only for the three states that mean "we know it will not answer":
     * a breaker refusing, a rate-limit window running, or a venue that has never
     * worked. `degraded` and `recovering` stay true — both still answer, and
     * deciding not to ask is exactly the judgement this model exists to avoid
     * making at every call site by hand.
     */
    available: boolean;
}

export interface ProviderFailureReport {
    httpStatus?: number | undefined;
    /** True when the failure was a refusal to try again, not an outage. */
    definitive?: boolean | undefined;
    retryAfterMs?: number | undefined;
}

interface ProviderRecord {
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    consecutiveFailures: number;
    lastLatencyMs: number | null;
    lastHttpStatus: number | null;
    rateLimitedUntil: number;
    retryAfterMs: number | null;
}

function emptyRecord(): ProviderRecord {
    return {
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        lastLatencyMs: null,
        lastHttpStatus: null,
        rateLimitedUntil: 0,
        retryAfterMs: null,
    };
}

const records = new Map<string, ProviderRecord>();

function recordFor(provider: string): ProviderRecord {
    const existing = records.get(provider);

    if (existing !== undefined) {
        return existing;
    }

    const created = emptyRecord();

    records.set(provider, created);

    return created;
}

/**
 * Forgets one venue.
 *
 * Scoped to a venue rather than to the whole registry on purpose: the breakers
 * are per-venue, so a reset of one venue's transport state must not also erase
 * the evidence that a *different* venue is currently down. A test that resets
 * the primary and then reads "every venue is healthy" would be reading a state
 * the production code can never produce.
 */
export function resetProviderHealth(provider?: string): void {
    if (provider === undefined) {
        records.clear();

        return;
    }

    records.delete(provider);
}

export function recordProviderSuccess(
    provider: string,
    details: { latencyMs: number; httpStatus?: number | undefined } = {
        latencyMs: 0,
    },
): void {
    const record = recordFor(provider);

    record.lastSuccessAt = Date.now();
    record.consecutiveFailures = 0;
    record.lastLatencyMs = details.latencyMs;

    if (details.httpStatus !== undefined) {
        record.lastHttpStatus = details.httpStatus;
    }
}

export function recordProviderFailure(
    provider: string,
    details: ProviderFailureReport = {},
): void {
    const record = recordFor(provider);

    record.lastFailureAt = Date.now();
    record.lastLatencyMs = null;

    if (details.httpStatus !== undefined) {
        record.lastHttpStatus = details.httpStatus;
    }

    // `definitive: false` is this process refusing on purpose — the breaker is
    // open, so no request was ever made. The venue is not evidence of anything
    // and must not be counted.
    //
    // Leaving this out is worse than it sounds. Every refused request arrives
    // here, and during a real outage that is every request the application
    // serves. The streak then grows for the entire outage, so by the time the
    // cooldown expires and the probe finally succeeds, the record already reads
    // as a venue with a long history of failure — and the one success that
    // would clear it is one call against many. The model would then keep a
    // recovered venue off the roster on the strength of our own policy.
    if (details.definitive !== false) {
        record.consecutiveFailures += 1;
    }
}

export function recordProviderRateLimit(
    provider: string,
    details: { retryAfterMs: number; httpStatus?: number | undefined },
): void {
    const record = recordFor(provider);

    record.lastFailureAt = Date.now();
    record.lastLatencyMs = null;
    record.retryAfterMs = details.retryAfterMs;
    record.rateLimitedUntil = Date.now() + details.retryAfterMs;

    // Deliberately not counted as a failure in the streak. A rate limit is a
    // refusal with a known end, and it already has two things enforcing it: the
    // window above and the breaker's own `openFor`. Counting it a third time
    // would make a venue that throttles occasionally look like one that is
    // broken — and once the window expired it would still read as failing, so
    // a healthy provider stays off the roster for a reason that has expired.
    if (details.httpStatus !== undefined) {
        record.lastHttpStatus = details.httpStatus;
    }
}

/**
 * The state, worked out from the record and the breaker.
 *
 * Order matters and is the whole design. The breaker is consulted first because
 * it is the only one of the three that knows about the *policy* decision to stop
 * asking; a venue whose breaker is open is `circuit_open` even if no call has
 * been made against it yet. The rate-limit window is next, because it has an
 * end: a window that has passed is no longer a reason to refuse, and treating
 * an expired one as current is how a provider that recovered an hour ago stays
 * silenced.
 */
export function providerHealthState(
    provider: string,
    circuit: CircuitBreakerState,
    now: number = Date.now(),
): ProviderHealthState {
    // A venue nobody has called yet is treated as an empty record rather than
    // short-circuited to a default. That matters because the circuit check has
    // to come first, and a short-circuit above it would answer `degraded` for a
    // venue whose breaker is open — reporting as merely unproven a provider
    // this process has already decided not to call.
    const record = records.get(provider) ?? emptyRecord();

    if (circuit === 'open') {
        return 'circuit_open';
    }

    if (record.rateLimitedUntil > now) {
        return 'rate_limited';
    }

    if (circuit === 'probing') {
        // The cooldown elapsed and a probe is about to run. The venue is not
        // known-good; it is being given one chance to be.
        return 'recovering';
    }

    if (record.consecutiveFailures > 0) {
        return record.lastSuccessAt === null ? 'unavailable' : 'recovering';
    }

    if (record.lastSuccessAt === null) {
        // Never called, or called only through a self-expiring rate limit.
        // Reporting `unavailable` would be a claim that it was tried and
        // failed; reporting `healthy` would be optimism about an upstream
        // nobody has heard from. Degraded says "no evidence", which is true.
        return 'degraded';
    }

    return now - record.lastSuccessAt > marketConfig.providerDegradedAfterMs
        ? 'degraded'
        : 'healthy';
}

export function isProviderAvailable(
    provider: string,
    circuit: CircuitBreakerState,
    now: number = Date.now(),
): boolean {
    const state = providerHealthState(provider, circuit, now);

    return (
        state === 'healthy' || state === 'degraded' || state === 'recovering'
    );
}

export function providerHealth(
    provider: string,
    circuit: CircuitBreakerState,
    now: number = Date.now(),
): ProviderHealthSnapshot {
    const record = records.get(provider) ?? emptyRecord();
    const state = providerHealthState(provider, circuit, now);
    const rateLimited = record.rateLimitedUntil > now;

    return {
        provider,
        state,
        circuit,
        lastSuccessAt: record.lastSuccessAt,
        lastFailureAt: record.lastFailureAt,
        consecutiveFailures: record.consecutiveFailures,
        lastLatencyMs: record.lastLatencyMs,
        lastHttpStatus: record.lastHttpStatus,
        retryAfterMs: rateLimited ? record.rateLimitedUntil - now : 0,
        available:
            state === 'healthy' ||
            state === 'degraded' ||
            state === 'recovering',
    };
}

/** Every venue this process has ever heard of, in registration order. */
export function knownProviders(): string[] {
    return [...records.keys()];
}
