import type {
    AssetPrice,
    Candle,
} from '../../types/market';

export interface MarketDataProvider {
    getPrice(): Promise<AssetPrice>;

    getCandles(
        limit?: number,
    ): Promise<Candle[]>;
}
