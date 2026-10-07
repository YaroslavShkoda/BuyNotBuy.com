import { z } from 'zod';
import type { MarketProviderName } from '../types/venue.js';
import { MARKET_VENUES } from '../types/venue.js';
import { MAX_CANDLE_LIMIT } from './market.defaults.js';

/**
 * The shapes of the market configuration, and nothing else.
 *
 * Split out of the config monolith because the schema is the one part of it
 * with no side effects: it reads no environment, resolves no venue, refuses
 * nothing at import time. It declares what a market setting must look like —
 * and a file of pure declarations is the one file that can be read without
 * wondering what running it does.
 *
 * The field comments are load-bearing and live on the fields, exactly where
 * they were.
 */

/**
 * A venue this application knows how to read.
 *
 * Built from the vocabulary rather than retyped, for the reason the whole
 * schema is here: `z.enum` needs values and the type it infers does not
 * survive to runtime, so writing the three strings here separately is how a
 * fourth venue ends up accepted by the configuration and unknown to every
 * provider.
 */
export const MarketProviderSchema = z.enum(MARKET_VENUES);

/**
 * What each venue is declared to serve, PHASE 3.1.
 *
 * **Derived from the settings that already exist rather than a new one.** The
 * primary was built with `MARKET_SYMBOL` and the backups with
 * `MARKET_FALLBACK_SYMBOL`, so that *is* the deployment's capability model —
 * writing it down separately would create a second place to be wrong, and the
 * two would disagree on the first deployment that served two markets.
 *
 * An explicit override exists for the deployment that really does run several
 * markets, and it is a list rather than a single pair precisely because a
 * single pair cannot express `bitget` serving SOLUSDT and BTCUSDT while
 * `binance` serves only the first.
 */
export const VenueCapabilitySchema = z.object({
    venue: MarketProviderSchema,
    instruments: z.array(z.string().min(1)).min(1),
    intervals: z.array(z.string().regex(/^[0-9]+[mhdw]$/)).min(1),
});

export const MarketConfigSchema = z.object({
    provider: MarketProviderSchema,
    /**
     * Where to go when the primary will not answer.
     *
     * Ordered, because more than one backup is a realistic answer to a venue
     * being unreachable from a region: the first is preferred, the rest are
     * tried in order. Empty means no backup, which is a legitimate setting for
     * a deployment that would rather see an error than a price from somewhere
     * other than where it asked.
     */
    fallbackProviders: z.array(MarketProviderSchema),
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
    /**
     * Every market this process observes, primary first.
     *
     * One market by default. The entries were already checked against the asset
     * registry before they reached here, so this only guards the shape — a list
     * that is empty, or whose first entry is not the configured `symbol`, would
     * mean the process and the frozen routes disagreed about which market they
     * are on, and nothing downstream would notice.
     */
    symbols: z.array(z.string().regex(/^[A-Z0-9]{1,32}$/)).min(1),
    /**
     * Where the backup is reached, and under which ticker.
     *
     * Separate from the primary's, because a pair that trades on one venue need
     * not trade on the other, and because the whole point of the backup is that
     * its address is known to work from wherever the server is deployed.
     */
    fallbackBaseUrl: z.string().min(1),
    /**
     * What each venue is declared to serve.
     *
     * Present as data rather than derived at each call site, so the deployment
     * has one answer to "who can serve what" and the router cannot answer it
     * differently depending on who asked.
     */
    venueCapabilities: z.array(VenueCapabilitySchema),
    fallbackSymbol: z.string()
        .min(1)
        .regex(/^[A-Z0-9]{1,32}$/, {
            message: 'Fallback symbol must be an uppercase alphanumeric ticker',
        }),
    candleInterval: z.string()
        .min(1)
        .regex(/^[0-9]+[mhdw]$/, {
            message: 'Candle interval must look like 1m, 4h, 1d or 1w',
        }),
    /**
     * The same interval in milliseconds, derived from the same setting.
     *
     * The series validator needs a duration to tell a still-forming bar from a
     * provider that stopped updating, and from a hole in the middle of the
     * series. Parsing the label at each call site would mean several places
     * each re-implementing the same format; here it is computed once, or the
     * process refuses to start.
     *
     * A field rather than a transform on `candleInterval`, because the string
     * is what goes to the venue and `3600000` is not an interval any of them
     * accept.
     */
    candleIntervalMs: z.coerce.number().int().positive(),
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
     * How long a venue may go without a single success before it is reported as
     * degraded rather than healthy.
     *
     * Silence is not health. A provider that is never called looks exactly like
     * one that answers instantly, and the only difference between the two is how
     * long ago the last answer was — which is why "is it up" cannot be answered
     * from the counters alone.
     */
    providerDegradedAfterMs: z.coerce.number().int().min(0),
    /**
     * Recent provider latencies kept for the percentiles.
     *
     * Bounded on purpose. A process that survives for months must not grow a
     * sample list for the life of the process, and the percentiles only ever
     * describe recent behaviour anyway.
     */
    providerLatencySampleSize: z.coerce
        .number()
        .int()
        .min(1)
        .max(100_000),
    /**
     * Where a backfill starts when it is asked for "everything".
     *
     * A timestamp rather than a count, because a count is a different request
     * every time the interval or the symbol changes, and a backfill whose
     * starting point depends on what it is filling is not resumable. A date is
     * the one thing both the caller and the run can name.
     */
    backfillFrom: z.coerce.number().int().min(0),
    /**
     * How many bars one backfill page asks the venue for.
     *
     * The venue's own maximum, by default. Asking for more is answered by the
     * venue with a page of its own size and no error, so a too-large request is
     * silently a short backfill — and the short part is the oldest part, which
     * is the part nobody notices is missing.
     */
    backfillPageSize: z.coerce.number().int().positive().max(1000),
    /**
     * Pause between backfill pages.
     *
     * Not a retry delay — the transport already has one. This is the gap
     * between pages, so a backfill of ten thousand bars is ten thousand calls
     * made over hours rather than in a burst, which is the difference between
     * filling a table and getting the address banned.
     */
    backfillPageDelayMs: z.coerce.number().int().min(0),
    /**
     * Binance blocks unidentified clients; naming the caller keeps the traffic
     * attributable and polite.
     */
    userAgent: z.string().min(1),
}).refine((config) => config.retryBaseDelayMs <= config.retryMaxDelayMs, {
    message: 'Retry base delay must not exceed the maximum retry delay',
    path: ['retryBaseDelayMs'],
}).refine((config) => config.cacheTtlMs <= config.maxStaleMs, {
    message: 'Cache TTL must not exceed the maximum age for serving stale data',
    path: ['cacheTtlMs'],
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/**
 * Re-exported rather than inferred here.
 *
 * This type used to be `z.infer<typeof MarketProviderSchema>`, which made the
 * configuration's idea of a venue and `provider-http.ts`'s idea of a venue two
 * separately declared types of the same name — structurally identical, so
 * nothing complained, and divergent the day a fourth venue was added to one of
 * them. The vocabulary lives in `types/venue.ts`.
 */
export type { MarketProviderName };
