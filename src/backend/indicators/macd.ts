import { calculateEMA } from './ema.js';

/**
 * MACD line, signal line and histogram.
 *
 * The histogram is the distance between the two lines rather than their
 * difference of EMAs, so that it is directly comparable with the signal line
 * plotted on the same scale. It is also the only part of this indicator that
 * says anything on its own: the two lines are always positive and negative by
 * construction, and only their crossing means anything.
 *
 * The reading is returned as a fraction, not a currency amount, so it can be
 * compared between instruments and rendered as a percentage.
 */
export interface MacdResult {
    macd: number;
    signal: number;
    histogram: number;
}

export function calculateMACD(
    closes: number[],
    fastPeriod: number,
    slowPeriod: number,
    signalPeriod: number,
): MacdResult {
    if (closes.length === 0) {
        throw new Error('MACD requires at least one close');
    }

    if (fastPeriod <= 0 || slowPeriod <= 0 || signalPeriod <= 0) {
        throw new Error('MACD periods must be greater than 0');
    }

    if (fastPeriod >= slowPeriod) {
        // A "fast" average that is slower than the "slow" one is not a fast
        // average, and the histogram would come out inverted rather than merely
        // wrong.
        throw new Error('MACD fast period must be shorter than the slow period');
    }

    // Every EMA in the chain needs its own window, and the signal line is an
    // EMA of the MACD line, so the MACD line has to exist for at least
    // `signalPeriod` bars before there is anything to smooth.
    const required = slowPeriod + signalPeriod;

    if (closes.length < required) {
        throw new Error(`MACD requires at least ${required} closes`);
    }

    // One EMA per bar, not one over the whole series: the signal line is an
    // average of the MACD line over time, so the MACD line has to be a
    // sequence rather than a single number.
    const macdSeries: number[] = [];
    const fastMultiplier = 2 / (fastPeriod + 1);
    const slowMultiplier = 2 / (slowPeriod + 1);

    let fast = closes
        .slice(0, fastPeriod)
        .reduce((sum, value) => sum + value, 0) / fastPeriod;
    let slow = closes
        .slice(0, slowPeriod)
        .reduce((sum, value) => sum + value, 0) / slowPeriod;

    for (let index = fastPeriod; index < closes.length; index += 1) {
        const value = closes[index];

        if (value === undefined) {
            throw new Error('MACD requires at least one close');
        }

        fast = (value - fast) * fastMultiplier + fast;

        if (index >= slowPeriod) {
            slow = (value - slow) * slowMultiplier + slow;
            macdSeries.push(fast - slow);
        }
    }

    const signal = calculateEMA(macdSeries, signalPeriod);
    const macd = macdSeries[macdSeries.length - 1];

    if (macd === undefined) {
        throw new Error('MACD requires at least one close');
    }

    return {
        macd,
        signal,
        histogram: macd - signal,
    };
}
