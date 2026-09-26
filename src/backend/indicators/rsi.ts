import type { Candle } from '../types/market.js';

/**
 * Relative Strength Index on a 0-100 scale.
 *
 * Averaged rather than summed on purpose. A sum of gains and a sum of losses
 * both grow with the window length, so the ratio of the two would look identical
 * at 14 bars and at 100 bars and would in fact be comparing different
 * quantities — the reading would move when the window changed, for reasons that
 * have nothing to do with the market.
 *
 * The first `period` bars have no average to compare against, so they are
 * skipped and the reading starts at bar `period`. Returning a value earlier
 * would mean dividing by an average of nothing.
 */
export function calculateRSI(candles: Candle[], period: number): number {
    if (candles.length === 0) {
        throw new Error('RSI requires at least one candle');
    }

    if (period <= 0) {
        throw new Error('RSI period must be greater than 0');
    }

    if (candles.length < period + 1) {
        throw new Error(`RSI requires at least ${period + 1} candles`);
    }

    let averageGain = 0;
    let averageLoss = 0;

    // Seed the averages over the first `period` changes, then continue with the
    // Wilder smoothing after that.
    for (let index = 1; index <= period; index += 1) {
        const candle = candles[index];
        const previous = candles[index - 1];

        if (candle === undefined || previous === undefined) {
            continue;
        }

        const change = candle.close - previous.close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        if (index < period) {
            averageGain += gain / period;
            averageLoss += loss / period;
        } else {
            averageGain = (averageGain * (period - 1) + gain) / period;
            averageLoss = (averageLoss * (period - 1) + loss) / period;
        }
    }

    for (let index = period + 1; index < candles.length; index += 1) {
        const candle = candles[index];
        const previous = candles[index - 1];

        if (candle === undefined || previous === undefined) {
            continue;
        }

        const change = candle.close - previous.close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        averageGain = (averageGain * (period - 1) + gain) / period;
        averageLoss = (averageLoss * (period - 1) + loss) / period;
    }

    // A window with no losses at all is not an infinite strength. It is an
    // upper bound the ratio cannot express: dividing by a zero average loss is
    // a division by nothing, and the honest answer is the top of the scale.
    if (averageLoss === 0) {
        return averageGain === 0 ? 50 : 100;
    }

    const relativeStrength = averageGain / averageLoss;

    return 100 - 100 / (1 + relativeStrength);
}
