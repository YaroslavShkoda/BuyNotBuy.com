import {
    backoffDelayMs,
    isRateLimited,
    parseRetryAfterMs,
    resetProviderTransport,
    sendProviderRequest,
} from './provider-http.js';

/**
 * The Binance face of the shared transport.
 *
 * The retry, timeout and circuit-breaker behaviour lives in provider-http and is
 * not Binance's. What is left here is the name this venue is logged and
 * measured under, kept behind the same exported names so the provider and its
 * tests read the way they always have.
 */

interface BinanceRequestOptions {
    url: string;
    /** Path only, so it is safe to put in logs and never carries a secret. */
    endpoint: string;
    /**
     * The market this request is for.
     *
     * Part of this layer's own options rather than something the transport reads
     * from configuration: the transport is keyed by venue and market, so the market
     * has to arrive with the request. Carried explicitly so every caller states it
     * once instead of the transport guessing from a provider instance.
     */
    market: string;
    /** Caller-side cancellation, combined with the per-attempt timeout. */
    signal?: AbortSignal;
}

/** Test hook: the breaker is process-wide state, like any circuit breaker. */
export function resetBinanceTransport(market?: string): void {
    resetProviderTransport('binance', market);
}

export function sendBinanceRequest(
    options: BinanceRequestOptions,
): Promise<Response> {
    return sendProviderRequest({ provider: 'binance', ...options });
}

export { backoffDelayMs, isRateLimited, parseRetryAfterMs };
