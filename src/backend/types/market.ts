export interface BitcoinPrice {
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
    price: BitcoinPrice;
    candles: Candle[];
}