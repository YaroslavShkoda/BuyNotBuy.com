import type { MarketProviderName } from '../types/venue.js';

/**
 * The literal defaults of the market configuration, and nothing else.
 *
 * Split out of the config monolith so that "what a deployment gets when it
 * sets nothing" is readable in one screen: every value here is a string in
 * exactly the form the environment takes, because the runtime builds the
 * same `process.env ?? default` expression it always built and the schema
 * coerces. A default is data, not code — the moment one of these needs a
 * branch, it has stopped being a default.
 */

/** Binance /api/v3/klines silently caps the limit at 1000 per request. */
export const MAX_CANDLE_LIMIT = 1000;

/** The venue that backs the primary by default, named once for the two uses. */
const MARKET_DEFAULT_FALLBACK_VENUE = 'bitget';

export const MARKET_DEFAULTS = {
    primaryProvider: 'binance',
    symbol: 'BTCUSDT',
    candleInterval: '1h',

    baseUrl: 'https://data-api.binance.vision',
    fallbackBaseUrl: 'https://api.bitget.com',

    defaultCandleLimit: '900',
    requestTimeoutMs: '10000',
    cacheTtlMs: '60000',
    maxStaleMs: '3600000',

    maxRetries: '2',
    retryBaseDelayMs: '250',
    retryMaxDelayMs: '5000',
    circuitFailureThreshold: '5',
    circuitCooldownMs: '30000',
    maxRetryAfterMs: '120000',

    providerDegradedAfterMs: '300000',
    providerLatencySampleSize: '512',

    // 2017-11-01. BTCUSDT hourly bars start around then, so this asks for the
    // whole history by default rather than a plausible-looking subset.
    backfillFrom: '1509600000000',
    backfillPageSize: String(MAX_CANDLE_LIMIT),
    backfillPageDelayMs: '1000',

    userAgent: 'BuyNotBuy.com/1.0 (+https://buynotbuy.com)',
} as const;

/**
 * A mock primary has no backup on purpose: the setting exists so the suite and
 * a laptop can run with no network at all, and a live venue behind it would
 * quietly make the suite depend on the internet again.
 */
export function defaultFallbackProviders(primary: MarketProviderName): string {
    return primary === 'mock' ? '' : MARKET_DEFAULT_FALLBACK_VENUE;
}
