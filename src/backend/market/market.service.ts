import { assertCandleSeries, findCandleSeriesIssues } from './candle-validation.js';
import { classifyFreshness, isUsableForSignal } from './market-freshness.js';
import {
    activeMarketVenue,
    anyMarketProviderAvailable,
    marketDataProvider,
    requestedMarketSymbol,
} from './market.provider.js';

import { MAX_CANDLE_LIMIT, marketConfig } from '../config/market.config.js';
import { requiredCandleCount } from '../config/indicator.config.js';
import { MarketDataError } from '../errors/market-data.error.js';
import { currentRegistry } from '../observability/registry.js';
import { createSingleFlight } from '../observability/single-flight.js';

import type { MarketFreshness } from './market-freshness.js';
import type { AssetPrice, MarketData } from '../types/market.js';

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

let cache: CacheEntry | null = null;
let inFlight: Promise<MarketDataResult> | null = null;

const priceFlight = createSingleFlight<AssetPrice>();

export async function getPrice(): Promise<AssetPrice> {
    // Coalesced, not cached. A price is a reading of a moment, and handing back
    // the previous one under this name would be publishing a stale number as a
    // live one — but N callers arriving together should still cost the
    // provider one request, and every one of them should see the same reading
    // rather than N different ones microseconds apart.
    const { result } = await priceFlight.run(() => marketDataProvider.getPrice());

    return result;
}

/**
 * Drops the cached snapshot and any in-flight request. Exposed for tests and
 * for the shutdown path so one run cannot leak a snapshot into the next.
 */
export function resetMarketDataCache(): void {
    cache = null;
    inFlight = null;
}

export async function getMarketData(): Promise<MarketDataResult> {
    const cached = cache;
    const now = Date.now();

    if (
        cached !== null &&
        now - cached.fetchedAt < marketConfig.cacheTtlMs
    ) {
        // A cache hit means nobody was asked, so whether the feed is alive has
        // to be looked up separately. Without this the dashboard reports a dead
        // market as a healthy one: both venues circuit-open, every page load
        // served from memory, and `X-Data-Stale: false` on all of them.
        const anyProviderAvailable = anyMarketProviderAvailable();

        currentRegistry().counter('market_cache_hits');

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

    // Concurrent callers share one provider request instead of each starting
    // their own; the shared result is cached, so a burst of page loads costs
    // a single upstream call.
    if (inFlight === null) {
        // Counted only on the branch that actually starts an upstream call.
        // Ten page loads sharing one request cost the provider one request, and
        // a counter that said ten would be measuring the dashboard's traffic
        // rather than what the cache was worth.
        currentRegistry().counter('market_cache_misses');
        inFlight = fetchAndCache().finally(() => {
            inFlight = null;
        });
    }

    return inFlight;
}

async function fetchAndCache(): Promise<MarketDataResult> {
    try {
        const data = await fetchMarketData();

        cache = { data, fetchedAt: Date.now() };

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
        const fallback = cache;
        const ageMs = fallback === null
            ? Number.POSITIVE_INFINITY
            : Date.now() - fallback.fetchedAt;

        const freshness = classifyFreshness({
            ageMs: fallback === null ? null : ageMs,
            providerAnswered: false,
            anyProviderAvailable: anyMarketProviderAvailable(),
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
            currentRegistry().counter('market_stale_served');

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

async function fetchMarketData(): Promise<MarketData> {
    const requestedSymbol = requestedMarketSymbol();
    const { venue, symbol, candles } =
        await marketDataProvider.getAttributedCandles(
            resolveCandleLimit(),
        );

    // A fallback configured with a different ticker is a legitimate setting, but
    // answering from it while reporting the primary's symbol is not: the price
    // of one asset would be published under another's name, and nothing
    // downstream could tell. Refused rather than relabelled.
    if (symbol !== requestedSymbol) {
        throw new MarketDataError(
            'Market data provider answered with a different symbol than requested',
            {
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: venue,
                    requestedSymbol,
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
            symbol: requestedSymbol,
            price: lastCandle.close,
        },
        candles,
        provider: venue,
        symbol: requestedSymbol,
        interval: marketConfig.candleInterval,
        // Market time, not fetch time. The two differ by up to one interval and
        // only this one belongs in a record meant to be replayed.
        timestamp: lastCandle.timestamp + marketConfig.candleIntervalMs,
    };
}

/**
 * The one place that decides whether a series is good enough to build on.
 *
 * Shared with the quality score so the two cannot disagree: a snapshot the
 * freshness model calls unusable and one the quality score calls perfect would
 * produce a dashboard that shows a green quality bar over a signal that was
 * refused.
 */
export function isSnapshotUsable(result: MarketDataResult): boolean {
    return isUsableForSignal(result.freshness);
}

/** Test hook: the raw series verdict, for the quality score and its tests. */
export function inspectCandles(candles: MarketData['candles']) {
    return findCandleSeriesIssues(
        candles,
        Date.now(),
        MAX_CANDLE_LIMIT,
        marketConfig.candleIntervalMs,
    );
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
