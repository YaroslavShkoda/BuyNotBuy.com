import type {
    AssetPrice,
    Candle,
} from '../../types/market.js';

/**
 * Candles plus who produced them.
 *
 * The venue is part of the result rather than something a caller looks up
 * afterwards. `getCandles` cannot carry it, because its callers are the
 * backtest and the price path, which have no use for the attribution — but the
 * snapshot path does, and a venue read from provider state after the fact is
 * wrong the moment two requests overlap: the second one to finish is the one
 * whose answer is in the hand, and the state's `preferred` index belongs to
 * whichever request last moved it.
 */
export interface ProviderCandles {
    venue: string;
    /** The ticker this venue was actually asked for. */
    symbol: string;
    candles: Candle[];
}

export interface MarketDataProvider {
    /**
     * This venue's name, as the rest of the backend knows it.
     *
     * Required rather than optional because every consumer needs it: the
     * snapshot records it, the health registry keys on it, the telemetry groups
     * by it, and the failover names it in its errors. A provider that cannot
     * name itself cannot be reported on, and "which venue is this?" is the first
     * question asked about every market-data incident.
     */
    readonly name: string;

    /** The ticker this venue trades, which need not match the primary's. */
    readonly symbol: string;

    getPrice(): Promise<AssetPrice>;

    getCandles(
        limit?: number,
    ): Promise<Candle[]>;

    /**
     * Historical candles, older than the live window.
     *
     * Separate from `getCandles` because the live window is sized for the
     * indicator warm-up, and a backtest needs far more history than that to
     * have anything to evaluate out of sample. Binance caps a single request
     * at 1000 candles, so a provider that can serve more has to page.
     */
    getHistoricalCandles(limit: number): Promise<Candle[]>;

    /**
     * The live window, attributed.
     *
     * `getCandles` delegates here, so a provider only ever implements the fetch
     * once and the two cannot drift apart.
     */
    getAttributedCandles(limit?: number): Promise<ProviderCandles>;
}
