export interface AssetPrice {
    symbol: string;
    price: number;
}

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface MarketData {
    price: AssetPrice;
    candles: Candle[];
}
