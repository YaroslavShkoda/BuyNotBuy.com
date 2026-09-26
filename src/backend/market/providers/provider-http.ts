import { MarketDataError } from '../../errors/market-data.error.js';
import { marketConfig } from '../../config/market.config.js';

import { CircuitBreaker } from './circuit-breaker.js';

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

const breakers = new Map<MarketProviderName, CircuitBreaker>();

function breakerFor(provider: MarketProviderName): CircuitBreaker {
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
    provider: MarketProviderName;
    url: string;
    /** Path only, so it is safe to put in logs and never carries a secret. */
    endpoint: string;
    /** Caller-side cancellation, combined with the per-attempt timeout. */
    signal?: AbortSignal;
}

/** Test hook: the breaker is process-wide state, like any circuit breaker. */
export function resetProviderTransport(provider: MarketProviderName): void {
    breakerFor(provider).reset();
}

export function isRateLimited(error: unknown): boolean {
    return (
        error instanceof MarketDataError &&
        error.code === 'MARKET_RATE_LIMITED'
    );
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
        throw circuitOpenError(options.provider, options.endpoint, breaker);
    }

    for (let attempt = 0; ; attempt += 1) {
        let response: Response;

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
            breaker.recordFailure();

            // A caller who has already given up is not a provider failure to
            // paper over with more attempts.
            if (options.signal?.aborted === true) {
                throw error;
            }

            if (attempt >= maxRetries) {
                throw error;
            }

            await delay(backoffDelayMs(attempt), options.signal);

            continue;
        }

        if (isRateLimitStatus(response.status, options.provider)) {
            const retryAfterMs = resolveRetryAfterMs(response);

            breaker.openFor(retryAfterMs);

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

            return response;
        }

        if (response.status < 500 || attempt >= maxRetries) {
            // A 4xx is a decision, not an outage: repeating it only burns
            // weight. A 5xx that survived every retry is a real failure.
            if (response.status >= 500) {
                breaker.recordFailure();
            } else {
                breaker.recordSuccess();
            }

            return response;
        }

        breaker.recordFailure();

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
    provider: MarketProviderName,
): boolean {
    // 418 is Binance's "IP auto-banned" response; it behaves like a 429. It is
    // left to Binance because the status is that venue's own convention, and
    // reading it as a throttle elsewhere would misreport an ordinary error.
    return status === 429 || (provider === 'binance' && status === 418);
}

function circuitOpenError(
    provider: MarketProviderName,
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
