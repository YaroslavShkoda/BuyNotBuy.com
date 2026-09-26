import type {
    AssetPrice,
    Candle,
} from '../../types/market.js';

export interface MarketDataProvider {
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
}
