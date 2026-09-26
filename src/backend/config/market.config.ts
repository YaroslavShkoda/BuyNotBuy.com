import { z } from 'zod';

/** Binance /api/v3/klines silently caps the limit at 1000 per request. */
export const MAX_CANDLE_LIMIT = 1000;

const MarketConfigSchema = z.object({
    provider: z.enum(['binance', 'mock']),
    /**
     * Market data must travel over TLS. A plaintext connection lets anyone on
     * the path rewrite prices, which this application would then report as a
     * genuine signal — the one failure mode a trading dashboard cannot afford.
     *
     * Loopback is exempt: a local mock or proxy over HTTP carries no market
     * data worth intercepting, and forbidding it would push developers towards
     * disabling the check entirely.
     */
    baseUrl: z.url().refine((value) => {
        const url = new URL(value);

        if (url.protocol === 'https:') {
            return true;
        }

        return (
            url.protocol === 'http:' &&
            (url.hostname === 'localhost' ||
                url.hostname === '127.0.0.1' ||
                url.hostname === '::1' ||
                url.hostname === '[::1]')
        );
    }, {
        message:
            'Market base URL must use HTTPS, except on loopback where HTTP carries no market data',
    }),
    symbol: z.string()
        .min(1)
        // Binance returns 400 for anything it cannot route, so a malformed
        // symbol is worth catching at the boundary rather than as a live
        // provider error on every request.
        .regex(/^[A-Z0-9]{1,32}$/, {
            message: 'Symbol must be an uppercase alphanumeric ticker',
        }),
    candleInterval: z.string()
        .min(1)
        .regex(/^[0-9]+[mhdw]$/, {
            message: 'Candle interval must look like 1m, 4h, 1d or 1w',
        }),
    defaultCandleLimit: z.coerce
        .number()
        .int()
        .positive()
        .max(MAX_CANDLE_LIMIT),
    requestTimeoutMs: z.coerce.number().int().positive(),
    /**
     * How long a fetched snapshot counts as fresh. Candles close once an hour,
     * so a minute of caching removes almost every duplicate provider call
     * without making the dashboard a minute behind the market.
     */
    cacheTtlMs: z.coerce.number().int().min(0),
    /**
     * How long a snapshot may still be served after the provider starts
     * failing. Beyond this the age of the data stops being defensible and the
     * error is reported instead.
     */
    maxStaleMs: z.coerce.number().int().min(0),
    /**
     * Retries for a transient failure (network, timeout, 5xx). Candles close
     * once an hour, so a second attempt costs a few hundred milliseconds and
     * saves the whole dashboard from a single dropped packet.
     */
    maxRetries: z.coerce.number().int().min(0).max(5),
    retryBaseDelayMs: z.coerce.number().int().min(0),
    /** Upper bound on one backoff step, so retries cannot stall a request. */
    retryMaxDelayMs: z.coerce.number().int().min(0),
    /**
     * Consecutive failures that trip the breaker. Once it is open, requests
     * fail immediately instead of piling onto an upstream that is already
     * refusing to answer.
     */
    circuitFailureThreshold: z.coerce.number().int().min(1),
    circuitCooldownMs: z.coerce.number().int().min(0),
    /**
     * Cap on how long a `Retry-After` from the provider is obeyed. Binance can
     * ask for minutes; no HTTP request should hang for minutes, so the wait
     * turns into a fast failure the snapshot cache can cover instead.
     */
    maxRetryAfterMs: z.coerce.number().int().min(0),
    /**
     * Binance blocks unidentified clients; naming the caller keeps the traffic
     * attributable and polite.
     */
    userAgent: z.string().min(1),
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

export const marketConfig: MarketConfig = MarketConfigSchema.parse({
    provider:
        process.env.MARKET_PROVIDER ??
        'binance',

    baseUrl:
        process.env.MARKET_BASE_URL ??
        'https://data-api.binance.vision',

    symbol:
        process.env.MARKET_SYMBOL ??
        'BTCUSDT',

    candleInterval:
        process.env.MARKET_CANDLE_INTERVAL ??
        '1h',

    defaultCandleLimit:
        process.env.MARKET_DEFAULT_CANDLE_LIMIT ??
        '900',

    requestTimeoutMs:
        process.env.MARKET_REQUEST_TIMEOUT_MS ??
        '10000',

    cacheTtlMs:
        process.env.MARKET_CACHE_TTL_MS ??
        '60000',

    maxStaleMs:
        process.env.MARKET_MAX_STALE_MS ??
        '3600000',

    maxRetries:
        process.env.MARKET_MAX_RETRIES ??
        '2',

    retryBaseDelayMs:
        process.env.MARKET_RETRY_BASE_DELAY_MS ??
        '250',

    retryMaxDelayMs:
        process.env.MARKET_RETRY_MAX_DELAY_MS ??
        '5000',

    circuitFailureThreshold:
        process.env.MARKET_CIRCUIT_FAILURE_THRESHOLD ??
        '5',

    circuitCooldownMs:
        process.env.MARKET_CIRCUIT_COOLDOWN_MS ??
        '30000',

    maxRetryAfterMs:
        process.env.MARKET_MAX_RETRY_AFTER_MS ??
        '120000',

    userAgent:
        process.env.MARKET_USER_AGENT ??
        'BuyNotBuy.com/1.0 (+https://buynotbuy.com)',
});
