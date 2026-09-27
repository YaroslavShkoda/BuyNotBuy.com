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
    /**
     * The venue that actually produced these candles.
     *
     * Not the configured primary. When the primary is unreachable the backup
     * answers, and the two venues print different numbers for the same hour: the
     * backup's last trade is not the primary's. Anything downstream that mixes
     * snapshots from different venues — a chart, a signal series, a stored
     * snapshot — produces a jump that looks exactly like a market move, so the
     * venue travels with the data instead of being a property of the
     * deployment.
     */
    provider: string;
    /** The symbol this snapshot was requested for. */
    symbol: string;
    /** Candle interval as configured, e.g. `1h`. */
    interval: string;
    /**
     * Market time: the close of the newest closed candle, in epoch
     * milliseconds.
     *
     * Not `Date.now()`. The distinction is the difference between "when we
     * looked" and "what the market did", and only the second one belongs in a
     * record that is meant to be replayable.
     */
    timestamp: number;
}

