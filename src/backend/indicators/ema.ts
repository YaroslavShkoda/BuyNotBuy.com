export function calculateEMA(
    values: number[],
    period: number,
): number {
    if (values.length === 0) {
        throw new Error(`EMA requires at least one value`);
    }

    if (period <= 0) {
        throw new Error(`EMA period must be greater than 0`);
    }

    if (values.length < period) {
        throw new Error(`EMA requires at least ${period} values`);
    }

    const multiplier = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((sum, value) => sum + value, 0) / period;

    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
}