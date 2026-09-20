import type {
    BitcoinPrice,
    Candle,
} from '../../types/market';

export interface MarketDataProvider {
    getBitcoinPrice(): Promise<BitcoinPrice>;

    getBitcoinCandles(
        limit?: number,
    ): Promise<Candle[]>;
}