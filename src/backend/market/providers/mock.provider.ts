import { marketConfig } from '../../config/market.config.js';

import { CANDLE_INTERVAL_MS, type CandleInterval } from '../../types/candle-interval.js';
import type {
    AssetPrice,
    Candle,
} from '../../types/market.js';

import type { MarketDataProvider, ProviderCandles } from './market-data.provider.js';

export class MockProvider implements MarketDataProvider {
    readonly name = 'mock';

    readonly symbol: string;

    /**
     * The interval the mock builds its bars at, defaulting to the configured
     * one. A mock bound to one interval while the request names another would
     * put hourly bars on a daily chart — series-shaped, finite, and wrong in
     * the exact way a real venue's would not be.
     */
    private readonly interval: CandleInterval;
    private readonly intervalMs: number;

    constructor(symbol: string = marketConfig.symbol, interval: CandleInterval = marketConfig.candleInterval) {
        this.symbol = symbol;
        this.interval = interval;
        this.intervalMs = CANDLE_INTERVAL_MS[interval];
    }

    async getPrice(): Promise<AssetPrice> {
        return {
            symbol: this.symbol,
            price: 100000,
        };
    }

    async getCandles(
        limit: number = marketConfig.defaultCandleLimit,
    ): Promise<Candle[]> {
        return this.buildCandles(limit);
    }

    async getAttributedCandles(
        limit: number = marketConfig.defaultCandleLimit,
    ): Promise<ProviderCandles> {
        return {
            venue: this.name,
            symbol: this.symbol,
            interval: this.interval,
            candles: this.buildCandles(limit),
        };
    }

    /**
     * The mock has no upstream cap, so history is the same series, simply
     * longer. Backtests run against it see a straight line, which is the point:
     * a deterministic series is what makes a metric assertion meaningful.
     */
    async getHistoricalCandles(limit: number): Promise<Candle[]> {
        return this.buildCandles(limit);
    }

    private buildCandles(limit: number): Candle[] {
        const candles: Candle[] = [];

        const intervalMs = this.intervalMs;
        const count = Math.max(0, limit - 1);

        // Anchored to the current hour rather than to a fixed date, because a
        // provider that stopped updating in November 2023 is not a stand-in for
        // one that answers now — and the series validator, correctly, refuses
        // to build a signal from one. The *values* stay exactly as
        // deterministic as they were: a straight line, one bar per hour, with
        // the same spacing. Only the labels move, and they move to where a
        // real venue's would be.
        const newestOpen = Math.floor(Date.now() / intervalMs) * intervalMs;
        const startTimestamp = newestOpen - count * intervalMs;

        // Binance always ends a klines response with the bar that is still
        // forming, and the provider layer drops it. The mock used to hand back
        // a full `limit` of closed bars, which quietly hid the fact that the
        // warm-up window was one bar short of what the caller had asked for.
        for (let i = 0; i < count; i += 1) {
            const close = 100000 + i;

            candles.push({
                timestamp: startTimestamp + i * intervalMs,
                open: close - 10,
                high: close + 10,
                low: close - 20,
                close,
                volume: 1000,
            });
        }

        return candles;
    }
}
