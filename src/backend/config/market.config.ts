import { z } from 'zod';

import { describeUnresolved, resolveInstrument } from './asset.registry.js';

import { MARKET_VENUES } from '../types/venue.js';
import type { MarketProviderName } from '../types/venue.js';

/** Binance /api/v3/klines silently caps the limit at 1000 per request. */
export const MAX_CANDLE_LIMIT = 1000;

/**
 * Returns the symbol if the registry understands it, and refuses to start if it
 * does not.
 *
 * The refusal is thrown, not returned, because the alternative is a process
 * that runs and cannot parse the market it was configured to trade. Every other
 * config failure in this file is already fatal at import time, and a symbol is
 * no different: it is the one setting a running system is least able to do
 * without.
 */
function resolvableSymbol(symbol: string): string {
    if (resolveInstrument(symbol) === null) {
        throw new Error(
            `MARKET_SYMBOL is set to ${describeUnresolved(symbol)}. ` +
                'The process will not start on a market it cannot name.',
        );
    }

    return symbol;
}

/**
 * A venue this application knows how to read.
 *
 * Built from the vocabulary rather than retyped, for the reason the whole file
 * is here: `z.enum` needs values and the type it infers does not survive to
 * runtime, so writing the three strings here separately is how a fourth venue
 * ends up accepted by the configuration and unknown to every provider.
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
const VenueCapabilitySchema = z.object({
    venue: MarketProviderSchema,
    instruments: z.array(z.string().min(1)).min(1),
    intervals: z.array(z.string().regex(/^[0-9]+[mhdw]$/)).min(1),
});

/**
 * Reads the capability list, or describes the deployment from its own settings.
 *
 * Format: `binance=BTCUSDT,ETHUSDT@1m,1h;bitget=SOLUSDT@1h`. The `@` separates
 * markets from intervals because a venue serves a cross product of the two, and
 * a format that listed intervals once per market would let a deployment declare
 * BTCUSDT at 1h and ETHUSDT at nothing without the config noticing.
 */
function parseVenueCapabilities(
    raw: string | undefined,
    primary: MarketProviderName,
    primarySymbol: string,
    fallbackSymbol: string,
    interval: string,
): z.infer<typeof VenueCapabilitySchema>[] {
    if (raw === undefined || raw.trim() === '') {
        return [
            {
                venue: primary,
                instruments: [primarySymbol],
                intervals: [interval],
            },
            {
                // Was `MarketProviderSchema.parse('bitget') as MarketProviderName`:
                // a constant string parsed through a validator and cast back to
                // the type the validator was built from, so the whole expression
                // was `'bitget'`. It existed because the two declarations of the
                // vocabulary were separate.
                venue: 'bitget' as const,
                instruments: [fallbackSymbol],
                intervals: [interval],
            },
        ].filter(
            (entry, index, all) =>
                all.findIndex((other) => other.venue === entry.venue) === index,
        );
    }

    return raw
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
            const [venuePart, marketsPart] = part.split('=');

            if (venuePart === undefined || marketsPart === undefined) {
                throw new Error(
                    `MARKET_VENUE_CAPABILITIES entry "${part}" is not "venue=MARKETS@intervals"`,
                );
            }

            const [instrumentsPart, intervalsPart] = marketsPart.split('@');

            if (instrumentsPart === undefined || intervalsPart === undefined) {
                throw new Error(
                    `MARKET_VENUE_CAPABILITIES entry for "${venuePart}" is missing the "@intervals" part`,
                );
            }

            return {
                venue: venuePart.trim(),
                instruments: instrumentsPart.split(',').map((ticker) => ticker.trim()),
                intervals: intervalsPart.split(',').map((step) => step.trim()),
            };
        })
        .map((entry) => VenueCapabilitySchema.parse(entry));
}

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
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/**
 * Resolved before the literal because the capability table is derived from
 * them, and a field cannot refer to a sibling declared after it. Naming them
 * here rather than repeating the environment reads keeps one definition of
 * what this deployment trades.
 */
const configuredSymbol = resolvableSymbol(process.env.MARKET_SYMBOL ?? 'BTCUSDT');
const configuredFallbackSymbol = resolvableSymbol(
    process.env.MARKET_FALLBACK_SYMBOL ??
        process.env.MARKET_SYMBOL ??
        'BTCUSDT',
);
const configuredInterval = process.env.MARKET_CANDLE_INTERVAL ?? '1h';

/**
 * Every market this process observes, in the order it observes them.
 *
 * **Derived, not a field, and the primary is not asked twice.** `symbol` is the
 * market the frozen `/api/analysis` and `/api/market` routes answer for, so it
 * stays the primary and stays first. `MARKET_SYMBOLS` names the *rest*, and every
 * name in it goes through the same `resolvableSymbol` that refuses an unknown
 * ticker at boot — so adding a market cannot buy the failure mode this file
 * exists to prevent, where `symbol` was well-formed and meaningless at the same
 * time and only one of the two was being checked.
 *
 * Unset means exactly one market, which is what every deployment of this project
 * has ever run. The list is a seam, not a switch: nothing about the behaviour
 * changes until someone names a second market, and the loop that consumes it is
 * written and tested with two so that the day it is used it has been run.
 *
 * The duplicates and the primary are removed rather than refused, because a list
 * that names the same market twice is a typo with an obvious reading, and a
 * process that observes BTCUSDT twice would write its history and its signals
 * twice — silently, since both tables key on the series.
 */
function observedMarkets(primary: string): readonly string[] {
    const extra = (process.env['MARKET_SYMBOLS'] ?? '')
        .split(',')
        .map((name) => name.trim().toUpperCase())
        .filter((name) => name.length > 0);

    return [primary, ...extra.filter((name) => name !== primary)]
        .map(resolvableSymbol)
        // Every repeat is dropped, not just the ones naming the primary.
        //
        // The filter above removes the primary from the added list because a
        // primary listed twice is a mistake in the reading of the setting. It
        // does not remove a repeat **inside** the added list, and it did not for
        // as long as this function existed: the comment above promised both and
        // the code delivered one.
        //
        // The reason it matters is that this array is the loop in `server.ts`,
        // and every pass publishes signals, settles forward returns, reconciles
        // outcomes and flushes the history backlog. `MARKET_SYMBOLS=ETHUSDT,ETHUSDT`
        // therefore ran the whole cycle twice per tick — and `storeSnapshot`
        // deduplicates on the input hash, so the duplication showed up in no
        // table an operator would check.
        //
        // `Set` rather than a filter over an index counter, because "first
        // occurrence wins" is the reading a person means when they write a name
        // twice, and it is the one the loop needs: order decides which market is
        // the primary of the extra list.
        .filter((name, index, all) => all.indexOf(name) === index);
}

const configuredSymbols = observedMarkets(configuredSymbol);

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

    candleInterval:
        configuredInterval,

    venueCapabilities: parseVenueCapabilities(
        process.env.MARKET_VENUE_CAPABILITIES,
        primaryProvider,
        configuredSymbol,
        configuredFallbackSymbol,
        configuredInterval,
    ),

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

    // Refuse to start on a symbol the asset registry cannot split. The shape
    // check above is necessary and not sufficient: `XRPBRL` passes
    // `/^[A-Z0-9]{1,32}$/`, the process starts, and the failure arrives from a
    // venue as an HTTP 400 naming a symbol this system has no way to interpret.
    // Two things were true at once — the ticker is well-formed and it is
    // meaningless — and only one of them was being checked.
    // This is a deliberate import of the registry from inside the config it
    // validates, and the cycle is the point rather than an accident: the
    // registry is an input to whether a market setting is usable, so the check
    // belongs where the setting is read. The dependency graph records it, and
    // `config` may import `instruments`, so the layering allows it.
    symbol: configuredSymbol,
    fallbackSymbol: configuredFallbackSymbol,

    /**
     * `symbol` first, then whatever `MARKET_SYMBOLS` named. One market by
     * default, so a deployment that sets nothing is unchanged.
     */
    symbols: configuredSymbols,
});

/**
 * Every configured market has to be a market some configured venue says it serves.
 *
 * **This was checked once per poll, on every poll, and nowhere else.** `symbols`
 * and `venueCapabilities` were parsed from two different settings and validated
 * independently, so a market configured but not declared produced a process that
 * started cleanly, logged a healthy `registry_seeded`, and then threw
 * `No configured venue does not serve ETHUSDT` on every cycle — for a
 * configuration that was wrong before the first request was made.
 *
 * The refusal itself was always right. What was wrong was its **timing** and its
 * **blast radius**: at boot the operator could not have known, and with two markets
 * the throw ended the cycle, skipped every market after it, and stopped retention
 * (which is why round 86's isolation is the thing that made this survivable
 * rather than this check).
 *
 * A boot refusal is the honest place for it. A market nobody will answer for is a
 * deployment mistake, and the whole design of this file is mistakes caught at the
 * moment the setting is read: an unresolvable ticker, a typo in a venue name, a
 * fallback that mocks the primary.
 *
 * **The message names both sides.** "ETHUSDT is configured but no venue declares
 * it" is a fixable sentence; "venue mismatch" is a search.
 */
function assertEveryMarketIsServed(configured: MarketConfig): void {
    // **Instrument *and* interval**, because that is what `serves()` asks, and
    // checking only the instrument was a check that passed on a configuration the
    // router would refuse.
    //
    // `binance=BTCUSDT,ETHUSDT@1h;bitget=BTCUSDT,ETHUSDT@4h` with
    // `MARKET_CANDLE_INTERVAL=1h` declares both markets on both venues, so this
    // check passed, the process started, seeded the registry, and **bound its
    // socket** — and then the first ingest scheduler called `configuredSeries`,
    // which routes through `serves()` with the real interval, got refused, and
    // exited. A crash loop that briefly serves traffic, from a configuration the
    // file's own docstring promises to catch at the moment the setting is read.
    const unserved = configured.symbols.flatMap((market) =>
        configured.venueCapabilities.some(
            (entry) =>
                entry.instruments.some(
                    (instrument) => instrument.trim().toUpperCase() === market.toUpperCase(),
                ) &&
                entry.intervals.some(
                    (step) => step.trim() === configured.candleInterval.trim(),
                ),
        )
            ? []
            : [market],
    );

    if (unserved.length === 0) {
        return;
    }

    // Both sides again, and the interval is part of what is declared now — a
    // message that printed `binance: BTCUSDT` while the problem was `bitget: 4h`
    // sends the reader to the wrong venue.
    const served = configured.venueCapabilities
        .map(
            (entry) =>
                `${entry.venue}: ${entry.instruments.join(', ')} @ ${entry.intervals.join(', ')}`,
        )
        .join('; ');

    throw new Error(
        `Рынки настроены, но ни одна площадка не обслуживает их ` +
            `на интервале ${configured.candleInterval}: ${unserved.join(', ')}. ` +
            `Объявлено — ${served}. ` +
            'Добавьте рынок в MARKET_VENUE_CAPABILITIES в формате ' +
            '`площадка=РЫНОКИ@интервалы` через `;`, например ' +
            '`binance=BTCUSDT,ETHUSDT@1h`, — интервал в объявлении должен ' +
            'совпадать с MARKET_CANDLE_INTERVAL.',
    );
}

assertEveryMarketIsServed(marketConfig);
