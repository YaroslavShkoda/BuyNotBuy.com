import { MarketDataError } from '../../errors/market-data.error.js';
import { marketConfig } from '../../config/market.config.js';

import { CircuitBreaker } from './circuit-breaker.js';
import * as health from './provider-health.js';
import * as telemetry from './provider-telemetry.js';

import type { CircuitBreakerState } from './circuit-breaker.js';


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

export type MarketProviderName = 'binance' | 'bitget' | 'mock';

const breakers = new Map<string, CircuitBreaker>();

function breakerFor(provider: string): CircuitBreaker {
    const existing = breakers.get(provider);

    if (existing !== undefined) {
        return existing;
    }

    const created = new CircuitBreaker({
        failureThreshold: marketConfig.circuitFailureThreshold,
        cooldownMs: marketConfig.circuitCooldownMs,
    });

    breakers.set(provider, created);

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
    url: string;
    /** Path only, so it is safe to put in logs and never carries a secret. */
    endpoint: string;
    /** Caller-side cancellation, combined with the per-attempt timeout. */
    signal?: AbortSignal;
}

/** Test hook: the breaker is process-wide state, like any circuit breaker. */
export function resetProviderTransport(provider: string): void {
    breakerFor(provider).reset();
    health.resetProviderHealth(provider);
}

/**
 * The breaker's current state for one venue.
 *
 * Exposed because the health model needs it and the breaker is the only thing
 * that knows about the *policy* decision to stop asking. Health alone would say
 * "the last call failed" and could not distinguish a venue that is merely
 * unlucky from one this process has deliberately stopped calling.
 */
export function providerCircuitState(provider: string): CircuitBreakerState {
    return breakerFor(provider).state;
}

export function isRateLimited(error: unknown): boolean {
    return (
        error instanceof MarketDataError &&
        error.code === 'MARKET_RATE_LIMITED'
    );
}

/**
 * Whether this venue is worth asking right now.
 *
 * The single answer every layer uses, so "can we still get a live price" is not
 * re-derived at each call site from a breaker state, a health record and a
 * config value in a slightly different combination.
 */
export function isVenueAvailable(provider: string): boolean {
    return health.isProviderAvailable(
        provider,
        breakerFor(provider).state,
    );
}

/** Health and telemetry for one venue, for the metrics and health endpoints. */
export function venueHealth(provider: string) {
    return health.providerHealth(provider, breakerFor(provider).state);
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
    const breaker = breakerFor(options.provider);
    const maxRetries = marketConfig.maxRetries;

    if (!breaker.tryAcquire()) {
        telemetry.recordProviderCircuitOpen(options.provider);
        health.recordProviderFailure(options.provider);

        throw circuitOpenError(options.provider, options.endpoint, breaker);
    }

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

            breaker.recordFailure();
            telemetry.recordProviderRequest(
                options.provider,
                options.endpoint,
                elapsedMs,
                null,
            );
            telemetry.recordProviderError(options.provider, options.endpoint);
            health.recordProviderFailure(options.provider);

            // A caller who has already given up is not a provider failure to
            // paper over with more attempts. It is also not a failure of the
            // venue, and recording it as one would let a shutdown — or a client
            // that simply navigated away — trip the breaker and take the venue
            // out for the next half minute of real traffic.
            if (options.signal?.aborted === true) {
                throw error;
            }

            if (attempt >= maxRetries) {
                throw error;
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
            telemetry.recordProviderRateLimited(options.provider);
            telemetry.recordProviderError(options.provider, options.endpoint);
            health.recordProviderRateLimit(options.provider, {
                retryAfterMs,
                httpStatus: response.status,
            });

            throw new MarketDataError(
                'Market data provider rate limit reached',
                {
                    code: 'MARKET_RATE_LIMITED',
                    retryAfterSeconds: Math.max(1, Math.round(retryAfterMs / 1000)),
                    cause: {
                        provider: options.provider,
                        endpoint: options.endpoint,
                        httpStatus: response.status,
                        retryAfterMs,
                        usedWeight: readUsedWeight(response),
                    },
                },
            );
        }

        if (response.ok) {
            breaker.recordSuccess();
            health.recordProviderSuccess(options.provider, {
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
                breaker.recordFailure();
                telemetry.recordProviderError(
                    options.provider,
                    options.endpoint,
                );
                health.recordProviderFailure(options.provider, {
                    httpStatus: response.status,
                });
            } else {
                breaker.recordSuccess();
                health.recordProviderSuccess(options.provider, {
                    latencyMs: elapsedMs,
                    httpStatus: response.status,
                });
            }

            return response;
        }

        breaker.recordFailure();
        telemetry.recordProviderError(options.provider, options.endpoint);
        health.recordProviderFailure(options.provider, {
            httpStatus: response.status,
        });

        if (attempt < maxRetries) {
            telemetry.recordProviderRetry(options.provider);
        }

        await delay(backoffDelayMs(attempt), options.signal);
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

function circuitOpenError(
    provider: string,
    endpoint: string,
    breaker: CircuitBreaker,
): MarketDataError {
    const retryAfterMs = breaker.retryAfterMs;

    return new MarketDataError(
        'Market data provider is temporarily disabled after repeated failures',
        {
            code: 'MARKET_DATA_UNAVAILABLE',
            retryAfterSeconds: Math.max(1, Math.round(retryAfterMs / 1000)),
            cause: {
                provider,
                endpoint,
                circuit: 'open',
                retryAfterMs,
            },
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
