/**
 * Momentum is a rate of change in percent, so it is always rendered as a
 * signed percentage. Keeping one formatter here is what stops the indicator
 * strip, the detail block and the divergence caption from drifting apart.
 */
export function formatMomentumPercent(value: number, fractionDigits = 2): string {
    const sign = value > 0 ? '+' : '';

    return `${sign}${value.toFixed(fractionDigits)}%`;
}

/**
 * An unsigned fraction of price, rendered as a percentage.
 *
 * ATR is stored as a fraction of price rather than in currency, and this is
 * where that decision becomes visible: "0.42%" means the same thing on any
 * instrument, where "640" would describe a BTC candle and a nothing at all on
 * a cheap one. No sign, because a range is never above or below anything.
 */
export function formatPercent(value: number, fractionDigits = 2): string {
    return `${(value * 100).toFixed(fractionDigits)}%`;
}

/**
 * A signed fraction, rendered as a percentage.
 *
 * The MACD histogram is a direction, so it needs a sign, and it is stored as a
 * fraction of price for the same reason ATR is: a value in currency is not
 * comparable between instruments.
 */
export function formatSignedPercent(value: number, fractionDigits = 2): string {
    const sign = value > 0 ? '+' : '';

    return `${sign}${(value * 100).toFixed(fractionDigits)}%`;
}
