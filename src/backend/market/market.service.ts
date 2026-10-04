import { requiredCandleCount } from '../config/indicator.config.js';
import { MAX_CANDLE_LIMIT, marketConfig } from '../config/market.config.js';
import { MarketDataError } from '../errors/market-data.error.js';
import { currentRegistry } from '../observability/registry.js';
import { createKeyedSingleFlight } from '../observability/single-flight.js';
import type { AssetPrice, MarketData } from '../types/market.js';
import { assertCandleSeries } from './candle-validation.js';
import type { MarketRequest } from './capability.js';
import {
    activeMarketVenue,
    anyMarketProviderAvailable,
    marketProviderFor,
} from './market.provider.js';
import type { MarketFreshness } from './market-freshness.js';
import { classifyFreshness } from './market-freshness.js';

export interface MarketDataResult {
    data: MarketData;
    /**
     * True when the payload was fetched earlier and is being served because
     * the provider is currently unavailable. The HTTP layer turns this into
     * the `X-Data-Stale` header so a consumer can tell a repeated reading
     * from a live one.
     *
     * Kept as its own field rather than derived from `freshness`, because the
     * header predates the freshness model and two states map onto it: a stale
     * snapshot and a current one served while every venue is down are both
     * "not freshly fetched", and the header's job is to say that much.
     */
    stale: boolean;
    /** Age of the underlying snapshot in milliseconds. */
    ageMs: number;
    /** Which venue actually produced this snapshot. */
    provider: string;
    /** The single answer to "how much should a caller trust this". */
    freshness: MarketFreshness;
}

interface CacheEntry {
    data: MarketData;
    fetchedAt: number;
}

/**
 * The cache and the flight, keyed by the market they belong to.
 *
 * **These were one variable and one promise, because there was one market.**
 * Adding a market to `getMarketData` without keying them would have been a
 * defect that reported no symptom: the second request would find a warm entry,
 * serve the first market's candles under the second market's name, and look
 * entirely healthy — right shape, plausible prices, a fresh timestamp. The
 * failure the whole multi-asset programme exists to prevent, delivered by the
 * change meant to prevent it.
 *
 * A key rather than a nested structure because the two together are the market,
 * and two markets that differ only in interval are different series with
 * different bar counts and different ages; serving one as the other is the same
 * error as serving BTC as EUR.
 */
export const marketKey = (request: MarketRequest): string =>
    `${request.instrument.toUpperCase()}|${request.interval}`;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MarketDataResult>>();

/**
 * The market a call that named none means.
 *
 * Defaulting rather than requiring keeps every existing caller — the frozen
 * API, the poller, the backtest — working unchanged while the parameter exists
 * only where a caller already knows which market it wants.
 *
 * **Per field, not per request.** The first version took `MarketRequest | undefined`
 * and fell back only when the whole object was missing, so a caller that named
 * an interval and no instrument — the first production caller to want exactly
 * that is the analysis, which is asked for a market and always takes the
 * configured interval — got an object whose `instrument` was `undefined` and
 * blew up on `toUpperCase`. A partial default is the ordinary case; a total one
 * is the rare case, and it is the rare one that was handled.
 *
 * Exported because the backtest asks the same question, and two copies of this
 * default would be two places where a change has to be remembered.
 */
export function resolveRequest(
    request?: { instrument?: string | undefined; interval?: string | undefined },
): MarketRequest {
    return {
        instrument: request?.instrument ?? marketConfig.symbol,
        interval: request?.interval ?? marketConfig.candleInterval,
    };
}

const priceFlights = createKeyedSingleFlight<AssetPrice>();

export async function getPrice(instrument?: string): Promise<AssetPrice> {
    // Coalesced, not cached. A price is a reading of a moment, and handing back
    // the previous one under this name would be publishing a stale number as a
    // live one — but N callers arriving together should still cost the
    // provider one request, and every one of them should see the same reading
    // rather than N different ones microseconds apart.
    //
    // Coalesced per market, for the same reason the snapshot is: one market's
    // shared reading must not be handed to a caller who asked about another,
    // and a single coalescer is exactly how that happens without a symptom.
    const wanted = instrument ?? marketConfig.symbol;
    const { result } = await priceFlights
        .forMarket(wanted)
        .run(() => marketProviderFor(wanted).getPrice());

    return result;
}

/**
 * Drops the cached snapshot and any in-flight request. Exposed for tests and
 * for the shutdown path so one run cannot leak a snapshot into the next.
 */
export function resetMarketDataCache(): void {
    cache.clear();
    inFlight.clear();
    priceFlights.reset();
}

/**
 * Counts a cache event once for the deployment and once for the market.
 *
 * **Both, and not either.** Labelling the counter was tried first and it silently
 * broke the contract: `value('market_cache_hits')` and every dashboard reading that
 * name kept working while returning `0`, because the series that now existed was
 * `market_cache_hits{market="BTCUSDT"}` — the same failure that cost
 * `signal_changes_total` its readers once already, for the same reason.
 *
 * So the unlabelled total stays exactly as promised, and the per-market breakdown
 * is an additional series on the same metric. Two entries in a map per cache event
 * is the price of a metric that keeps its name and also answers "which market".
 */
function countCacheEvent(name: string, market: string): void {
    const registry = currentRegistry();

    registry.counter(name);
    registry.counter(name, 1, { market });
}

export async function getMarketData(
    request?: { instrument?: string | undefined; interval?: string | undefined },
): Promise<MarketDataResult> {
    const wanted = resolveRequest(request);
    const key = marketKey(wanted);
    const cached = cache.get(key) ?? null;
    const now = Date.now();

    if (
        cached !== null &&
        now - cached.fetchedAt < marketConfig.cacheTtlMs
    ) {
        // A cache hit means nobody was asked, so whether the feed is alive has
        // to be looked up separately. Without this the dashboard reports a dead
        // market as a healthy one: both venues circuit-open, every page load
        // served from memory, and `X-Data-Stale: false` on all of them.
        //
        // **Asked about this market.** It used to ask about the process, so with
        // binance serving BTCUSDT and bitget serving ETHUSDT, a cache hit for
        // ETHUSDT was told binance was fine and reported `fresh` with
        // `X-Data-Stale: false` while the only venue trading ETHUSDT refused.
        const anyProviderAvailable = anyMarketProviderAvailable(wanted.instrument);

        countCacheEvent('market_cache_hits', wanted.instrument);

        return {
            data: cached.data,
            stale: !anyProviderAvailable,
            ageMs: now - cached.fetchedAt,
            provider: cached.data.provider,
            freshness: classifyFreshness({
                ageMs: now - cached.fetchedAt,
                providerAnswered: false,
                anyProviderAvailable,
                toleratedIssues: [],
                requiredCandles: requiredCandleCount(),
                actualCandles: cached.data.candles.length,
            }),
        };
    }

    // Concurrent callers asking for the same market share one provider request
    // instead of each starting their own. Keyed like the cache, and for the
    // same reason: one market's coalescing must not hand another market its
    // result, which is the one thing a shared promise would otherwise do
    // silently and on every concurrent load.
    if (!inFlight.has(key)) {
        // Counted only on the branch that actually starts an upstream call.
        // Ten page loads sharing one request cost the provider one request, and
        // a counter that said ten would be measuring the dashboard's traffic
        // rather than what the cache was worth.
        countCacheEvent('market_cache_misses', wanted.instrument);
        const flight = fetchAndCache(wanted).finally(() => {
            inFlight.delete(key);
        });

        inFlight.set(key, flight);
    }

    return inFlight.get(key) as Promise<MarketDataResult>;
}

async function fetchAndCache(request: MarketRequest): Promise<MarketDataResult> {
    const key = marketKey(request);

    try {
        const data = await fetchMarketData(request);

        cache.set(key, { data, fetchedAt: Date.now() });

        return {
            data,
            stale: false,
            ageMs: 0,
            provider: data.provider,
            freshness: 'fresh',
        };
    } catch (error) {
        // A provider outage should degrade the dashboard, not blank it: the
        // last good snapshot is still the truth about the last closed candle.
        // The response is flagged so nobody mistakes it for a live reading,
        // and an over-age snapshot is refused rather than passed off as data.
        //
        // The fallback is this market's own last snapshot. A failed EUR fetch
        // that served BTC candles would report success with the wrong prices.
        const fallback = cache.get(key) ?? null;
        const ageMs = fallback === null
            ? Number.POSITIVE_INFINITY
            : Date.now() - fallback.fetchedAt;

        const freshness = classifyFreshness({
            ageMs: fallback === null ? null : ageMs,
            providerAnswered: false,
            anyProviderAvailable: anyMarketProviderAvailable(request.instrument),
            toleratedIssues: [],
            requiredCandles:
                fallback === null ? undefined : fallback.data.candles.length,
            actualCandles:
                fallback === null ? undefined : fallback.data.candles.length,
        });

        if (
            fallback !== null &&
            freshness === 'stale'
        ) {
            // The one path in this module that serves data the market has moved
            // past. It is a metric rather than a log line because its whole
            // value is the shape over time: one stale hour during an outage is
            // the system working, and a stale hour every hour for a week is
            // the system having quietly stopped noticing.
            //
            // Per series as well as in total, because the shape over time is
            // only readable per series: one market answering every request from
            // cache while another was never cached at all is a single flat number
            // here and invisible in it.
            countCacheEvent('market_stale_served', request.instrument);

            return {
                data: fallback.data,
                stale: true,
                ageMs,
                provider: fallback.data.provider,
                freshness,
            };
        }

        throw error;
    }
}

async function fetchMarketData(request: MarketRequest): Promise<MarketData> {
    const { venue, symbol, candles } =
        await marketProviderFor(request.instrument).getAttributedCandles(
            resolveCandleLimit(),
        );

    // A fallback configured with a different ticker is a legitimate setting, but
    // answering from it while reporting the primary's symbol is not: the price
    // of one asset would be published under another's name, and nothing
    // downstream could tell. Refused rather than relabelled.
    //
    // With several markets live this is the check that carries the whole phase:
    // it is the one place where "the provider answered" and "the caller asked
    // for" meet, and it compares them against the market the caller named rather
    // than against whatever the configuration happens to say.
    if (symbol !== request.instrument) {
        throw new MarketDataError(
            'Market data provider answered with a different symbol than requested',
            {
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: venue,
                    requestedSymbol: request.instrument,
                    answeredSymbol: symbol,
                },
            },
        );
    }

    // Every provider funnels through here, so the invariants the indicators
    // rely on are checked exactly once. An unsorted or impossible series would
    // otherwise produce a confident signal from wrong numbers.
    //
    // The interval is passed so the check can also see a hole in the middle of
    // the series and a series that simply stopped updating. Both produce a
    // well-formed signal from a market that is not the one being displayed,
    // and neither is visible to any other check: the bars are sorted, unique,
    // finite, and have consistent ranges.
    assertCandleSeries(
        candles,
        Date.now(),
        venue,
        MAX_CANDLE_LIMIT,
        marketConfig.candleIntervalMs,
    );

    const lastCandle = candles.at(-1);

    if (lastCandle === undefined) {
        throw new MarketDataError(
            'Market data provider returned no candles',
            {
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: venue,
                    endpoint: '/api/v3/klines',
                    candleCount: candles.length,
                },
            },
        );
    }

    // The dashboard is a snapshot of the last fully closed hour, so the
    // reference price comes from that same candle instead of a live ticker
    // call: the signal, the chart and the "price above/below EMA" reading all
    // have to be computed against the same time base.
    return {
        price: {
            symbol: request.instrument,
            price: lastCandle.close,
        },
        candles,
        provider: venue,
        symbol: request.instrument,
        interval: request.interval,
        // Market time, not fetch time. The two differ by up to one interval and
        // only this one belongs in a record meant to be replayed.
        timestamp: lastCandle.timestamp + marketConfig.candleIntervalMs,
    };
}

/** The venue currently answering, or null when there is nothing to switch. */
export { activeMarketVenue };

/**
 * Never ask for less than the indicator warm-up needs, and never ask for more
 * than the provider can serve: Binance caps /api/v3/klines at 1000 candles and
 * silently returns 1000, which would look like a successful oversized request.
 */
function resolveCandleLimit(): number {
    // The last kline of any response is the bar that is still forming, and the
    // provider layer drops it. Asking for exactly `requiredCandleCount()` bars
    // therefore always arrives one bar short and fails the warm-up guard on
    // every single request, so the forming bar is requested as a spare.
    return Math.min(
        MAX_CANDLE_LIMIT,
        Math.max(marketConfig.defaultCandleLimit, requiredCandleCount()) + 1,
    );
}
