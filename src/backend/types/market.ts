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
    /**
     * Notional volume, in the pair's quote currency — USDT for BTCUSDT.
     *
     * Deliberately not the base-asset volume the venues also publish. Both
     * exchanges report how much of the pair traded *and* what that was worth,
     * and the panel shows the worth: the base figure on BTCUSDT is around 84,000
     * times smaller than the notional one, and labelling it "USDT" would
     * understate a day's trading by five orders of magnitude while still looking
     * like a plausible number.
     */
    volume: number;
}

export interface MarketData {
    price: AssetPrice;
    candles: Candle[];
}
