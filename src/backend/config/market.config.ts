import { z } from 'zod';

/** Binance /api/v3/klines silently caps the limit at 1000 per request. */
export const MAX_CANDLE_LIMIT = 1000;

/** A venue this application knows how to read. */
const MarketProviderSchema = z.enum(['binance', 'bitget', 'mock']);

/**
 * Reads the backup list from a comma-separated setting.
 *
 * Two rules, both about not quietly doing the wrong thing:
 *
 * - A backup that names the primary is dropped rather than rejected. A
 *   deployment that sets both to the same venue has asked for no backup, and
 *   the intent is unambiguous even though the setting is not.
 * - `mock` is refused outright. A mock is a test double, and a mock that took
 *   over would put invented prices on the dashboard the moment a real venue
 *   failed — the one outcome this application exists to avoid, and the one no
 *   screenshot of the page would ever make obvious.
 */
function parseFallbackProviders(
    raw: string,
    primary: MarketProviderName,
): MarketProviderName[] {
    const names = raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');

    if (names.includes('mock')) {
        throw new Error(
            'MARKET_FALLBACK_PROVIDERS cannot include "mock": a test double must never take over from a real venue',
        );
    }

    const parsed = MarketProviderSchema.array().parse(names);

    return parsed.filter((name) => name !== primary);
}

/**
 * A mock primary has no backup on purpose: the setting exists so the suite and
 * a laptop can run with no network at all, and a live venue behind it would
 * quietly make the suite depend on the internet again.
 */
function defaultFallbackProviders(
    primary: MarketProviderName,
): string {
    return primary === 'mock' ? '' : 'bitget';
}

export type MarketProviderName = z.infer<typeof MarketProviderSchema>;

/**
 * Read through the schema rather than cast, so an unsupported venue is named in
 * the failure instead of surfacing later as a default branch that throws the
 * same message for every typo. It is also needed twice — here and again for
 * the backup list — so it is resolved once, at the boundary, where the rest of
 * the configuration is validated.
 */
const primaryProvider = MarketProviderSchema.parse(
    process.env.MARKET_PROVIDER ?? 'binance',
);

/**
 * Turns a candle interval label into milliseconds.
 *
 * Called on the same string the schema validates, and the schema rejects an
 * unparseable one a few lines later, so by the time this is wrong the process
 * is already refusing to start. `NaN` is the honest answer for a label this
 * cannot read, and it fails the `positive()` integer check rather than
 * silently becoming zero.
 */
function intervalMs(label: string): number {
    const multipliers: Record<string, number> = {
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
        w: 604_800_000,
    };

    const unit = label.slice(-1);
    const amount = Number.parseInt(label.slice(0, -1), 10);

    return amount * (multipliers[unit] ?? Number.NaN);
}

/**
 * Whether this process is allowed to serve invented prices.
 *
 * The guard on the backup list already refuses a mock there, and for the same
 * reason it has to refuse one here: `MARKET_PROVIDER=mock` is a documented
 * setting, and a mock as the primary puts 900 synthetic candles on the
 * dashboard — passing every integrity check, since they are increasing, finite
 * and internally consistent — and reports them as a live signal with
 * `X-Data-Stale: false`. Nothing on the page would look wrong.
 *
 * The escape hatch is explicit and narrow: a test double is a legitimate thing
 * to run, so the setting that allows one exists, and it is named for what it
 * does rather than inferred from the environment.
 */
function mockProviderAllowed(): boolean {
    if (process.env.MARKET_ALLOW_MOCK === '1') {
        return true;
    }

    return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

if (primaryProvider === 'mock' && !mockProviderAllowed()) {
    throw new Error(
        'MARKET_PROVIDER=mock is not allowed outside the test suite: a mock ' +
            'primary serves invented prices as if they were live, and reports ' +
            'them with no staleness flag. Set MARKET_ALLOW_MOCK=1 if this is ' +
            'really what you want.',
    );
}

const MarketConfigSchema = z.object({    provider: MarketProviderSchema,
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
     * Where the backup is reached, and under which ticker.
     *
     * Separate from the primary's, because a pair that trades on one venue need
     * not trade on the other, and because the whole point of the backup is that
     * its address is known to work from wherever the server is deployed.
     */
    fallbackBaseUrl: z.string().min(1),
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
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

export const marketConfig: MarketConfig = MarketConfigSchema.parse({
    provider: primaryProvider,

    /**
     * Bitget is on by default rather than opt-in. The reason this project needs
     * a backup at all is that its primary venue is unreachable from some
     * networks, and a setting nobody turns on protects nobody. Set
     * MARKET_FALLBACK_PROVIDERS to an empty string to run without one.
     */
    fallbackProviders: parseFallbackProviders(
        process.env.MARKET_FALLBACK_PROVIDERS ?? defaultFallbackProviders(primaryProvider),
        primaryProvider,
    ),

    baseUrl:
        process.env.MARKET_BASE_URL ??
        'https://data-api.binance.vision',

    fallbackBaseUrl:
        process.env.MARKET_FALLBACK_BASE_URL ??
        'https://api.bitget.com',

    symbol:
        process.env.MARKET_SYMBOL ??
        'BTCUSDT',

    fallbackSymbol:
        process.env.MARKET_FALLBACK_SYMBOL ??
        'BTCUSDT',

    candleInterval:
        process.env.MARKET_CANDLE_INTERVAL ??
        '1h',

    candleIntervalMs: intervalMs(
        process.env.MARKET_CANDLE_INTERVAL ?? '1h',
    ),

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

    providerDegradedAfterMs:
        process.env.MARKET_PROVIDER_DEGRADED_AFTER_MS ??
        '300000',

    providerLatencySampleSize:
        process.env.MARKET_PROVIDER_LATENCY_SAMPLE_SIZE ??
        '512',

    // 2017-11-01. BTCUSDT hourly bars start around then, so this asks for the
    // whole history by default rather than a plausible-looking subset.
    backfillFrom:
        process.env.MARKET_BACKFILL_FROM ??
        '1509600000000',

    backfillPageSize:
        process.env.MARKET_BACKFILL_PAGE_SIZE ??
        String(MAX_CANDLE_LIMIT),

    backfillPageDelayMs:
        process.env.MARKET_BACKFILL_PAGE_DELAY_MS ??
        '1000',

    userAgent:
        process.env.MARKET_USER_AGENT ??
        'BuyNotBuy.com/1.0 (+https://buynotbuy.com)',
});
