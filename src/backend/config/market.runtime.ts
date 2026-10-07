import type { MarketProviderName } from '../types/venue.js';
import { parseVenueCapabilities } from './market.capabilities.js';
import { MARKET_DEFAULTS } from './market.defaults.js';
import { intervalMs, parseFallbackProviders, readMarketEnv } from './market.env.js';
import { type MarketConfig, MarketConfigSchema } from './market.schema.js';

/**
 * The assembled market configuration, and the refusals only a whole
 * configuration can make.
 *
 * Split out of the config monolith as the piece the other four exist for:
 * the environment is read once, the defaults fill what it does not say, the
 * schema gives the result its shape, and what remains here is the part no
 * field can carry — the checks between fields, and the one object the rest
 * of the process reads.
 */

const env = readMarketEnv();

export const marketConfig: MarketConfig = MarketConfigSchema.parse({
    provider: env.primaryProvider,

    /**
     * Bitget is on by default rather than opt-in. The reason this project needs
     * a backup at all is that its primary venue is unreachable from some
     * networks, and a setting nobody turns on protects nobody. Set
     * MARKET_FALLBACK_PROVIDERS to an empty string to run without one.
     */
    fallbackProviders: parseFallbackProviders(
        env.fallbackProvidersRaw,
        env.primaryProvider,
    ),

    baseUrl:
        process.env.MARKET_BASE_URL ??
        MARKET_DEFAULTS.baseUrl,

    fallbackBaseUrl:
        process.env.MARKET_FALLBACK_BASE_URL ??
        MARKET_DEFAULTS.fallbackBaseUrl,

    candleInterval: env.candleInterval,

    venueCapabilities: parseVenueCapabilities(
        process.env.MARKET_VENUE_CAPABILITIES,
        env.primaryProvider,
        env.symbol,
        env.fallbackSymbol,
        env.candleInterval,
    ),

    candleIntervalMs: intervalMs(env.candleInterval),

    defaultCandleLimit:
        process.env.MARKET_DEFAULT_CANDLE_LIMIT ??
        MARKET_DEFAULTS.defaultCandleLimit,

    requestTimeoutMs:
        process.env.MARKET_REQUEST_TIMEOUT_MS ??
        MARKET_DEFAULTS.requestTimeoutMs,

    cacheTtlMs:
        process.env.MARKET_CACHE_TTL_MS ??
        MARKET_DEFAULTS.cacheTtlMs,

    maxStaleMs:
        process.env.MARKET_MAX_STALE_MS ??
        MARKET_DEFAULTS.maxStaleMs,

    maxRetries:
        process.env.MARKET_MAX_RETRIES ??
        MARKET_DEFAULTS.maxRetries,

    retryBaseDelayMs:
        process.env.MARKET_RETRY_BASE_DELAY_MS ??
        MARKET_DEFAULTS.retryBaseDelayMs,

    retryMaxDelayMs:
        process.env.MARKET_RETRY_MAX_DELAY_MS ??
        MARKET_DEFAULTS.retryMaxDelayMs,

    circuitFailureThreshold:
        process.env.MARKET_CIRCUIT_FAILURE_THRESHOLD ??
        MARKET_DEFAULTS.circuitFailureThreshold,

    circuitCooldownMs:
        process.env.MARKET_CIRCUIT_COOLDOWN_MS ??
        MARKET_DEFAULTS.circuitCooldownMs,

    maxRetryAfterMs:
        process.env.MARKET_MAX_RETRY_AFTER_MS ??
        MARKET_DEFAULTS.maxRetryAfterMs,

    providerDegradedAfterMs:
        process.env.MARKET_PROVIDER_DEGRADED_AFTER_MS ??
        MARKET_DEFAULTS.providerDegradedAfterMs,

    providerLatencySampleSize:
        process.env.MARKET_PROVIDER_LATENCY_SAMPLE_SIZE ??
        MARKET_DEFAULTS.providerLatencySampleSize,

    backfillFrom:
        process.env.MARKET_BACKFILL_FROM ??
        MARKET_DEFAULTS.backfillFrom,

    backfillPageSize:
        process.env.MARKET_BACKFILL_PAGE_SIZE ??
        MARKET_DEFAULTS.backfillPageSize,

    backfillPageDelayMs:
        process.env.MARKET_BACKFILL_PAGE_DELAY_MS ??
        MARKET_DEFAULTS.backfillPageDelayMs,

    userAgent:
        process.env.MARKET_USER_AGENT ??
        MARKET_DEFAULTS.userAgent,

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
    symbol: env.symbol,
    fallbackSymbol: env.fallbackSymbol,

    /**
     * `symbol` first, then whatever `MARKET_SYMBOLS` named. One market by
     * default, so a deployment that sets nothing is unchanged.
     */
    symbols: env.symbols,
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

/**
 * The process-wide failover chain can only be a failover.
 *
 * **Two configurations it used to accept and that could not work.**
 *
 * 1. `MARKET_FALLBACK_SYMBOL` naming a **different market** from
 *    `MARKET_SYMBOL`. The chain was built from it — `[binance:BTCUSDT,
 *    bitget:ETHUSDT]` — so the moment the primary opened, BTCUSDT was served by a
 *    venue answering ETHUSDT. `market.service.ts` compares the symbol it was handed
 *    against the request and refuses, so no wrong price was stored; the failure was
 *    a 503 naming ETHUSDT on a BTCUSDT request, and the operator's first guess
 *    would have been the wrong venue. The setting still exists and still means what
 *    it says — a pair may not list everywhere — but a **substitution** cannot survive
 *    a symbol check, so a different ticker is a configuration this system cannot
 *    honour rather than one it can.
 *
 * 2. A `MARKET_FALLBACK_PROVIDERS` entry that does not declare the primary market.
 *    The chain is now built from the capability table, so such a venue is not in it
 *    — and the deployment would have one fewer backup than it declared, silently.
 *
 * Both are refused here rather than at the first failover, which is the same
 * reasoning as the market/interval check above: a setting that cannot be honoured
 * is a mistake to catch when it is read, and the later the refusal comes the more
 * traffic it has already served.
 */
function assertFailoverIsAFailover(configured: MarketConfig): void {
    if (configured.fallbackSymbol !== configured.symbol) {
        throw new Error(
            `Резерв объявлен на другом рынке: MARKET_FALLBACK_SYMBOL=` +
                `${configured.fallbackSymbol}, а основной рынок — ` +
                `${configured.symbol}. Подмена рынка резервом не поддерживается: ` +
                'цепочка отказоустойчивости обязана обслуживать тот же рынок, ' +
                'иначе ответ приходит от площадки, которая торгует другой ' +
                'инструмент. Уберите MARKET_FALLBACK_SYMBOL (тогда резерв берёт ' +
                'тот же тикер) или объявите оба рыка через MARKET_VENUE_CAPABILITIES.',
        );
    }

    const unserving = configured.fallbackProviders.filter((venue: MarketProviderName) => {
        const entry = configured.venueCapabilities.find(
            (capability) => capability.venue === venue,
        );

        return (
            entry === undefined ||
            !entry.instruments.some(
                (instrument) =>
                    instrument.trim().toUpperCase() ===
                    configured.symbol.toUpperCase(),
            ) ||
            !entry.intervals.some(
                (step) => step.trim() === configured.candleInterval.trim(),
            )
        );
    });

    if (unserving.length === 0) {
        return;
    }

    const declared = configured.venueCapabilities
        .map(
            (entry) =>
                `${entry.venue}: ${entry.instruments.join(', ')} @ ${entry.intervals.join(', ')}`,
        )
        .join('; ');

    throw new Error(
        `Резервные площадки не обслуживают основной рынок ` +
            `${configured.symbol} на интервале ${configured.candleInterval}: ` +
            `${unserving.join(', ')}. Объявлено — ${declared}. ` +
            'Резерв, который не торгует этим рынком, не может быть резервом для ' +
            'него: цепочка построена по таблице возможностей и не станет ' +
            'переключаться на площадку, которая этого рынка не знает.',
    );
}

assertEveryMarketIsServed(marketConfig);
assertFailoverIsAFailover(marketConfig);
