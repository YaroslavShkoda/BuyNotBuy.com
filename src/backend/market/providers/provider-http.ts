import { ProviderError, isSelfInflicted, statusForKind } from '../../errors/provider.error.js';
import { marketConfig } from '../../config/market.config.js';

import { CircuitBreaker } from './circuit-breaker.js';
import * as health from './provider-health.js';
import * as telemetry from './provider-telemetry.js';

import type { CircuitBreakerState } from './circuit-breaker.js';
import type { ProviderFailureKind } from '../../errors/provider.error.js';


/**
 * The outbound HTTP path, shared by every market data provider.
 *
 * None of this is exchange-specific: a timeout, an exponential backoff, a
 * circuit breaker and the treatment of a 429 are the same decisions whichever
 * venue answers. Only the name that ends up in the diagnostic differs, so the
 * venue is a parameter and the breaker is held per venue.
 *
 * A per-venue breaker is the point of the whole file. A provider that is
 * refusing to answer must stop consuming its share of the request budget, and
 * it must do so without taking the other provider down with it — which is what
 * one shared breaker would do the moment the first venue goes dark.
 */

import type { MarketProviderName } from '../../types/venue.js';

/**
 * Re-exported, not redeclared.
 *
 * This union was written out here and, separately, inferred from a Zod enum in
 * `config/market.config.ts` — two exported types of the same name that happened
 * to be structurally identical, so nothing ever complained. The vocabulary lives
 * in `types/venue.ts` now, where the configuration layer can reach it too.
 */
export type { MarketProviderName };

/**
 * One breaker per **venue and market**.
 *
 * It was one per venue, and that is a claim about the venue that the transport
 * cannot support: an instrument-specific 5xx, or a venue throttling one market
 * harder than another, opened a circuit that refused **every** market on that venue
 * for the whole cooldown — before a socket was opened. Symmetrically, one market's
 * success closed a circuit that another market's failures had earned.
 *
 * Keyed by market as well as venue, a failure that belongs to one series stays on
 * that series, which is what a breaker is for.
 */
const breakers = new Map<string, CircuitBreaker>();

function breakerKey(provider: string, market: string): string {
    return `${provider.toLowerCase()}:${market.trim().toUpperCase()}`;
}

function breakerFor(provider: string, market: string): CircuitBreaker {
    const key = breakerKey(provider, market);

    const existing = breakers.get(key);

    if (existing !== undefined) {
        return existing;
    }

    const created = new CircuitBreaker({
        failureThreshold: marketConfig.circuitFailureThreshold,
        cooldownMs: marketConfig.circuitCooldownMs,
    });

    breakers.set(key, created);

    return created;
}

export interface ProviderRequestOptions {
    /**
     * Which venue this call is for.
     *
     * A plain string rather than a union so the transport does not carry a
     * second, independent list of venues that can fall out of step with the
     * configured one. Adding a venue is a configuration change; it should not
     * also be a type change in the layer that only cares about sockets.
     */
    provider: string;
    /**
     * The market this call is for.
     *
     * Required, because it is half the key the breaker and the health record are
     * stored under. Left out, the transport would have to invent one — and whatever
     * it invented would be the venue name or nothing, which is exactly the keying
     * this removed.
     */
    market: string;
    url: string;
    /** Path only, so it is safe to put in logs and never carries a secret. */
    endpoint: string;
    /** Caller-side cancellation, combined with the per-attempt timeout. */
    signal?: AbortSignal;
}

/**
 * Test hook: everything this layer remembers about one venue.
 *
 * The breaker and the health record are process-wide state, like any circuit
 * breaker, and telemetry is a counter that only goes up — so a reset that
 * cleared two of the three would leave a suite that passes for the wrong
 * reason. A test asserting "this venue was asked once" has to be able to make
 * that true, and it cannot do so while a previous test's calls are still in
 * the count.
 */
export function resetProviderTransport(provider: string, market?: string): void {
    // A market narrows all three, a bare venue widens them across every market it
    // has served. Both spellings exist because a suite testing one series wants the
    // first and a suite wanting a clean slate wants the second, and they are not
    // the same request.
    if (market === undefined) {
        for (const known of health.knownMarkets(provider)) {
            breakerFor(provider, known).reset();
        }

        health.resetProviderHealth(provider);
        telemetry.resetProviderTelemetry(provider);

        return;
    }

    breakerFor(provider, market).reset();
    health.resetProviderHealth(provider, market);
    telemetry.resetProviderTelemetry(provider);
}

/**
 * The breaker's current state for one venue.
 *
 * Exposed because the health model needs it and the breaker is the only thing
 * that knows about the *policy* decision to stop asking. Health alone would say
 * "the last call failed" and could not distinguish a venue that is merely
 * unlucky from one this process has deliberately stopped calling.
 */
export function providerCircuitState(provider: string, market: string): CircuitBreakerState {
    return breakerFor(provider, market).state;
}

export function isRateLimited(error: unknown): boolean {
    return (
        error instanceof ProviderError &&
        error.kind === 'rate_limited'
    );
}

/**
 * The kind of failure, or null when it is not a provider failure at all.
 *
 * The one place a caller asks "what went wrong" without reading a message.
 * Null rather than a guess for anything unrecognised: an error this code has
 * never seen is not a timeout, and treating it as one would send it down the
 * retry path forever.
 */
export function providerFailureKind(
    error: unknown,
): ProviderFailureKind | null {
    return error instanceof ProviderError ? error.kind : null;
}

/**
 * Whether this venue is worth asking right now.
 *
 * The single answer every layer uses, so "can we still get a live price" is not
 * re-derived at each call site from a breaker state, a health record and a
 * config value in a slightly different combination.
 */
/**
 * Whether this venue can serve this market right now.
 *
 * Per market, because the breaker and the health record it consults are both keyed
 * by venue and market. Asking it about a venue alone would merge every market on
 * that venue back into the single answer this pair used to give.
 */
export function isVenueAvailable(provider: string, market: string): boolean {
    return health.isProviderAvailable(
        provider,
        market,
        breakerFor(provider, market).state,
    );
}

/** Health and telemetry for one venue and one market. */
export function venueHealth(provider: string, market: string) {
    return health.providerHealth(provider, market, breakerFor(provider, market).state);
}

/**
 * Health for a venue across every market it has served, naming the worst one.
 *
 * **The reports that iterate venues need this, and it is an aggregate rather than a
 * convenience.** A venue-level answer has to be an answer about the venue, so it
 * cannot silently take one market's record: a bitget that is healthy for BTCUSDT and
 * refusing ETHUSDT is not a healthy bitget. The state returned is the worst across
 * markets, and `market` says which one produced it — so the report is a summary that
 * can still be acted on rather than one line about an arbitrary series.
 *
 * Markets with no record are counted, as `degraded`: a venue nobody has called for
 * a market has no evidence, and the existing model already says exactly that about
 * a venue it has never called.
 */
export function venueHealthSummary(provider: string): ReturnType<typeof venueHealth> {
    const markets = health.knownMarkets(provider);

    if (markets.length === 0) {
        return health.providerHealth(provider, marketConfig.symbol, 'closed');
    }

    let worst = venueHealth(provider, markets[0]!);

    for (const market of markets.slice(1)) {
        const candidate = venueHealth(provider, market);

        if (severity(candidate.state) > severity(worst.state)) {
            worst = candidate;
        }
    }

    return worst;
}

/**
 * How bad a health state is, worst last.
 *
 * An order rather than a set because "is this worse" is asked constantly and a
 * caller comparing two states by hand is a caller that will get it wrong for
 * exactly one pair — which is how `available` and `state` drift apart.
 */
const SEVERITY: Record<string, number> = {
    healthy: 0,
    recovering: 1,
    degraded: 2,
    rate_limited: 3,
    circuit_open: 4,
    unavailable: 5,
};

/**
 * Ranks a state, with an unknown state ranked worst.
 *
 * The fallback matters more than it looks: a state this function has never heard of
 * must not be treated as harmless, and a missing key from an exhaustive record is
 * exactly the case where guessing low would produce a healthy-looking summary.
 */
function severity(state: string): number {
    return SEVERITY[state] ?? Number.POSITIVE_INFINITY;
}

/**
 * Performs one provider call, retrying only the failures that a second attempt
 * can actually fix.
 *
 * Retried: dropped connections, timeouts, 5xx. Not retried: 4xx, which are
 * decisions the provider has already made and will repeat, and anything thrown
 * while reading the body, which is a contract mismatch rather than a blip.
 *
 * A 429 is handled differently on purpose. A venue can send `Retry-After` and
 * punish clients that retry anyway, so the honest response is to stop calling
 * for that long and answer immediately — the snapshot cache covers the gap
 * instead of the request stalling behind a multi-minute sleep.
 */
export async function sendProviderRequest(
    options: ProviderRequestOptions,
): Promise<Response> {
    const breaker = breakerFor(options.provider, options.market);
    const maxRetries = marketConfig.maxRetries;

    // Read before the attempt, because `tryAcquire` only says yes. Whether the
    // yes was an ordinary slot or the single probe the cooldown was holding
    // decides who has to release it if the caller walks away.
    const wasProbing = breaker.state !== 'closed';

    if (!breaker.tryAcquire()) {
        telemetry.recordProviderCircuitOpen(options.provider);

        const refusal = circuitOpenError(
            options.provider,
            options.endpoint,
            breaker,
        );

        health.recordProviderFailure(options.provider, options.market, {
            // Our own decision, not the venue's answer. Asked of the error
            // rather than restated here so that "what counts as evidence
            // against a venue" has exactly one answer in the codebase.
            definitive: !isSelfInflicted(refusal),
        });

        throw refusal;
    }

    // If the slot was not closed, the only way `tryAcquire` says yes is by
    // taking the cooldown's single probe, so the state does not need reading a
    // second time — and this caller is now the one who has to release it.
    const admittedAsProbe = wasProbing;

    // The reservation covers the whole request, not one attempt.
    //
    // This is the burst case, and it is the reason the flag lives outside the
    // per-attempt bookkeeping. A request retries with a backoff, and during
    // that sleep the venue is still the one request that was admitted to test.
    // Releasing between attempts left the venue unprotected for the length of
    // every backoff, and a hundred callers arriving together walked in one per
    // gap — the exact thundering herd the breaker exists to prevent, arriving
    // at a venue that had just refused.
    //
    // So the transport owns the reservation and hands it back on every exit,
    // unless the breaker has already taken it back itself.
    let probeHeld = admittedAsProbe;

    try {
        for (let attempt = 0; ; attempt += 1) {
            let response: Response;
            const startedAt = performance.now();

            try {
                response = await fetch(options.url, {
                    signal: buildRequestSignal(options.signal),
                    headers: {
                        // Some venues block unidentified clients outright.
                        'User-Agent': marketConfig.userAgent,
                        Accept: 'application/json',
                    },
                });
            } catch (error) {
                const elapsedMs = performance.now() - startedAt;
                const callerGaveUp = options.signal?.aborted === true;

                // A caller who has already given up is not a provider failure to
                // paper over with more attempts. It is also not a failure of the
                // venue, and recording it as one would let a shutdown — or a
                // client that simply navigated away — trip the breaker and take
                // the venue out for the next half minute of real traffic.
                //
                // The check has to come *before* the recording, and it is here
                // because a shutdown aborts every in-flight request at once: a
                // rolling deploy would otherwise produce exactly the consecutive
                // failures that open the breaker, and the first request after
                // the restart would be refused by a circuit this process opened
                // against venues that were never actually unwell.
                //
                // The request still counts. It was made, it consumed a socket
                // and it took the time it took; leaving it out of the request
                // count would make the latency numbers describe a different set
                // of calls than the ones that happened.
                if (callerGaveUp) {
                    telemetry.recordProviderRequest(
                        options.provider,
                        options.endpoint,
                        elapsedMs,
                        null,
                    );

                    throw error;
                }

                breaker.recordAttemptFailure();
                telemetry.recordProviderRequest(
                    options.provider,
                    options.endpoint,
                    elapsedMs,
                    null,
                );
                telemetry.recordProviderError(options.provider, options.endpoint);
                health.recordProviderFailure(options.provider, options.market);

                if (attempt >= maxRetries) {
                    throw transportError(options, error);
                }

                telemetry.recordProviderRetry(options.provider);
                await delay(backoffDelayMs(attempt), options.signal);

                continue;
            }

        const elapsedMs = performance.now() - startedAt;

        telemetry.recordProviderRequest(
            options.provider,
            options.endpoint,
            elapsedMs,
            response.status,
        );

        if (isRateLimitStatus(response.status, options.provider)) {
            const retryAfterMs = resolveRetryAfterMs(response);

            breaker.openFor(retryAfterMs);
            probeHeld = false;
            telemetry.recordProviderRateLimited(options.provider);
            telemetry.recordProviderError(options.provider, options.endpoint);
            health.recordProviderRateLimit(options.provider, options.market, {
                retryAfterMs,
                httpStatus: response.status,
            });

            throw new ProviderError(
                'rate_limited',
                'Market data provider rate limit reached',
                {
                    statusCode: statusForKind('rate_limited'),
                    retryAfterSeconds: Math.max(1, Math.round(retryAfterMs / 1000)),
                    context: {
                        provider: options.provider,
                        endpoint: options.endpoint,
                        httpStatus: response.status,
                        retryAfterMs,
                        details: { usedWeight: readUsedWeight(response) },
                    },
                },
            );
        }

        if (response.ok) {
            breaker.recordSuccess();
            probeHeld = false;
            health.recordProviderSuccess(options.provider, options.market, {
                latencyMs: elapsedMs,
                httpStatus: response.status,
            });

            return response;
        }

        if (response.status < 500 || attempt >= maxRetries) {
            // A 4xx is a decision, not an outage: repeating it only burns
            // weight. A 5xx that survived every retry is a real failure.
            //
            // The two are separated in the health record as well, and that is not
            // bookkeeping for its own sake. A venue answering 404 has told us
            // something definite — the request is wrong — and marking it as
            // failed would eventually open its breaker and take a healthy venue
            // off the roster because of a bad parameter.
            if (response.status >= 500) {
                breaker.recordAttemptFailure();
                telemetry.recordProviderError(
                    options.provider,
                    options.endpoint,
                );
                health.recordProviderFailure(options.provider, options.market, {
                    httpStatus: response.status,
                });
            } else {
                breaker.recordSuccess();
                probeHeld = false;
                health.recordProviderSuccess(options.provider, options.market, {
                    latencyMs: elapsedMs,
                    httpStatus: response.status,
                });
            }

            // Thrown rather than returned, so every non-2xx leaves this layer
            // as the same typed failure no matter which venue produced it. A
            // returned `Response` is a branch the caller has to remember to
            // write; there are four call sites here today and each of them had
            // grown its own copy of "429 or 5xx is 503, otherwise 502", which
            // is precisely the duplication a transport layer exists to remove.
            throw httpStatusError(options, response.status);
        }

        breaker.recordAttemptFailure();
        telemetry.recordProviderError(options.provider, options.endpoint);
        health.recordProviderFailure(options.provider, options.market, {
            httpStatus: response.status,
        });

        if (attempt < maxRetries) {
            telemetry.recordProviderRetry(options.provider);
        }

        await delay(backoffDelayMs(attempt), options.signal);
        }
    } finally {
        // Every exit hands the reservation back, and the ones that already did
        // (`recordSuccess`, `openFor`) have cleared the local flag first. What
        // is left is a request that died without the breaker ever hearing
        // about it, which is the only way a venue can end up silent for the
        // life of the process.
        if (probeHeld) {
            breaker.releaseProbe();
        }
    }
}

/**
 * Full jitter: the delay is a random value in [0, cap]. A fixed schedule makes
 * every client that failed at the same moment retry at the same moment, which
 * is exactly the thundering herd the backoff exists to break up.
 */
export function backoffDelayMs(attempt: number): number {
    const exponential = Math.min(
        marketConfig.retryMaxDelayMs,
        marketConfig.retryBaseDelayMs * 2 ** attempt,
    );

    return Math.floor(Math.random() * exponential);
}

export function parseRetryAfterMs(header: string | null): number | null {
    if (header === null || header.trim() === '') {
        return null;
    }

    const seconds = Number(header);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }

    // The header may also be an HTTP date, per RFC 9110.
    const date = Date.parse(header);

    if (Number.isNaN(date)) {
        return null;
    }

    return Math.max(0, date - Date.now());
}

function resolveRetryAfterMs(response: Response): number {
    const parsed = parseRetryAfterMs(response.headers.get('retry-after'));

    if (parsed !== null) {
        return Math.min(parsed, marketConfig.maxRetryAfterMs);
    }

    // No usable hint: fall back to our own cooldown rather than guessing.
    return marketConfig.circuitCooldownMs;
}

/**
 * The used-weight header is the only way to tell "we are being throttled for
 * real" from "we happen to be near the limit", so it travels with the error.
 *
 * Binance has renamed this header more than once: `X-MBX-USED-WEIGHT-1` was
 * replaced by `X-MBX-USED-WEIGHT`, with a separate `X-MBX-USED-WEIGHT-1m` for
 * the rolling minute. All three are read so the diagnostic keeps working
 * whichever one the current API version happens to send. Another venue simply
 * sends none of them and the field comes back null, which is the honest answer.
 */
function readUsedWeight(response: Response): string | null {
    for (const header of [
        'x-mbx-used-weight-1',
        'x-mbx-used-weight',
        'x-mbx-used-weight-1m',
    ]) {
        const value = response.headers.get(header);

        if (value !== null && value !== '') {
            return value;
        }
    }

    return null;
}

function isRateLimitStatus(
    status: number,
    provider: string,
): boolean {
    // 418 is Binance's "IP auto-banned" response; it behaves like a 429. It is
    // left to Binance because the status is that venue's own convention, and
    // reading it as a throttle elsewhere would misreport an ordinary error.
    return status === 429 || (provider === 'binance' && status === 418);
}

/**
 * The status → failure mapping, in one table.
 *
 * Previously each provider re-implemented "429 or 5xx is a 503, anything else
 * non-2xx is a 502", in three places, with the 429 case handled separately
 * because it needed a `Retry-After`. A table makes the whole decision visible
 * at once and gives one place to add a status.
 *
 * The status a client sees is unchanged from what it saw before, deliberately.
 * This is an internal refactor of how failures are *described*, not a decision
 * to move a published contract, and a 5xx staying 503 is the status clients
 * have already been handling.
 *
 * The kind is not the same thing as the status, which is why both are here:
 * 5xx and a dead socket are both `unavailable` — the venue never produced an
 * answer, and that is exactly what a retry can fix — but the first is a 503 and
 * the second a 502, because the first is a service that is up and broken and
 * the second is a service this one could not reach at all.
 */
function httpStatusError(
    options: ProviderRequestOptions,
    status: number,
): ProviderError {
    const isThrottle =
        status === 429 || (options.provider === 'binance' && status === 418);

    const kind: ProviderFailureKind = isThrottle
        ? 'rate_limited'
        : status >= 500
          ? 'unavailable'
          : 'invalid_response';

    return new ProviderError(
        kind,
        `Market data provider request failed with HTTP ${status}`,
        {
            statusCode: isThrottle || status >= 500 ? 503 : 502,
            context: {
                provider: options.provider,
                endpoint: options.endpoint,
                httpStatus: status,
            },
        },
    );
}

function circuitOpenError(
    provider: string,
    endpoint: string,
    breaker: CircuitBreaker,
): ProviderError {
    const retryAfterMs = breaker.retryAfterMs;

    return new ProviderError(
        'circuit_open',
        'Market data provider is temporarily disabled after repeated failures',
        {
            statusCode: statusForKind('circuit_open'),
            retryAfterSeconds: Math.max(1, Math.round(retryAfterMs / 1000)),
            context: { provider, endpoint, retryAfterMs },
        },
    );
}

/**
 * Turns a thrown transport error into something a caller can branch on.
 *
 * The classification is by type rather than by message, because the two cases
 * need opposite treatment by whoever reads the log: a timeout means the venue
 * is reachable and slow, and a dropped connection means it is not reachable at
 * all. Reading "timed out" out of a sentence would work right up until a
 * runtime reworded it.
 */
function transportError(
    options: ProviderRequestOptions,
    error: unknown,
): ProviderError {
    const timedOut =
        error instanceof DOMException && error.name === 'TimeoutError';

    return new ProviderError(
        timedOut ? 'timeout' : 'unavailable',
        timedOut
            ? 'Market data provider timed out'
            : 'Market data provider could not be reached',
        {
            statusCode: statusForKind(timedOut ? 'timeout' : 'unavailable'),
            context: {
                provider: options.provider,
                endpoint: options.endpoint,
                details: {
                    originalError:
                        error instanceof Error
                            ? `${error.name}: ${error.message}`
                            : String(error),
                    ...(timedOut
                        ? { timeoutMs: marketConfig.requestTimeoutMs }
                        : {}),
                },
            },
            cause: error,
        },
    );
}

function buildRequestSignal(callerSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(marketConfig.requestTimeoutMs);

    // Combining rather than replacing keeps a caller-side cancellation working
    // once the transport layer grew its own deadline.
    return callerSignal === undefined
        ? timeout
        : AbortSignal.any([callerSignal, timeout]);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);

        function finish() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        }

        signal?.addEventListener('abort', finish, { once: true });
    });
}
