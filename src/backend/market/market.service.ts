import { marketDataProvider } from './market.provider.js';
import { assertCandleSeries } from './candle-validation.js';

import { MAX_CANDLE_LIMIT, marketConfig } from '../config/market.config.js';
import { requiredCandleCount } from '../config/indicator.config.js';
import { MarketDataError } from '../errors/market-data.error.js';

import type { AssetPrice, MarketData } from '../types/market.js';

export interface MarketDataResult {
    data: MarketData;
    /**
     * True when the payload was fetched earlier and is being served because
     * the provider is currently unavailable. The HTTP layer turns this into
     * the `X-Data-Stale` header so a consumer can tell a repeated reading
     * from a live one.
     */
    stale: boolean;
    /** Age of the underlying snapshot in milliseconds. */
    ageMs: number;
}

interface CacheEntry {
    data: MarketData;
    fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<MarketDataResult> | null = null;

export async function getPrice(): Promise<AssetPrice> {
    return marketDataProvider.getPrice();
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
        return {
            data: cached.data,
            stale: false,
            ageMs: now - cached.fetchedAt,
        };
    }

    // Concurrent callers share one provider request instead of each starting
    // their own; the shared result is cached, so a burst of page loads costs
    // a single upstream call.
    inFlight ??= fetchAndCache().finally(() => {
        inFlight = null;
    });

    return inFlight;
}

async function fetchAndCache(): Promise<MarketDataResult> {
    try {
        const data = await fetchMarketData();

        cache = { data, fetchedAt: Date.now() };

        return { data, stale: false, ageMs: 0 };
    } catch (error) {
        // A provider outage should degrade the dashboard, not blank it: the
        // last good snapshot is still the truth about the last closed candle.
        // The response is flagged so nobody mistakes it for a live reading,
        // and an over-age snapshot is refused rather than passed off as data.
        const fallback = cache;
        const ageMs = fallback === null
            ? Number.POSITIVE_INFINITY
            : Date.now() - fallback.fetchedAt;

        if (
            fallback !== null &&
            ageMs <= marketConfig.maxStaleMs
        ) {
            return {
                data: fallback.data,
                stale: true,
                ageMs,
            };
        }

        throw error;
    }
}

async function fetchMarketData(): Promise<MarketData> {
    const candles = await marketDataProvider.getCandles(
        resolveCandleLimit(),
    );

    // Every provider funnels through here, so the invariants the indicators
    // rely on are checked exactly once. An unsorted or impossible series would
    // otherwise produce a confident signal from wrong numbers.
    assertCandleSeries(candles, Date.now(), marketConfig.provider);

    const lastCandle = candles.at(-1);

    if (lastCandle === undefined) {
        throw new MarketDataError(
            'Market data provider returned no candles',
            {
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: marketConfig.provider,
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
            symbol: marketConfig.symbol,
            price: lastCandle.close,
        },
        candles,
    };
}

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
