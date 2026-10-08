import type { Candle } from '../types/market.js';

/**
 * Bollinger Bands, and how far price sits inside them.
 *
 * Context, not a vote, and the distinction is about what the number means.
 * A band is a statement about how far price has been travelling; %B is a
 * statement about where in that range it is now. Both are descriptions of the
 * market's shape, and neither takes a side — the same %B of 0.05 is a market
 * squeezing at the bottom of a range and a market falling out of one, and
 * nothing in the band distinguishes them. That is the job of ADX, which
 * measures whether there is a trend to fall out of.
 *
 * This is the reason they were added as context: putting them in the vote would
 * make the agreement figure rise without the signal getting any stronger, which
 * is the same objection that keeps RSI out.
 */
interface BollingerBands {
    /** The moving average the bands are centred on. */
    middle: number;
    upper: number;
    lower: number;
    /**
     * Width as a fraction of the middle band.
     *
     * A fraction rather than an absolute distance, so a band on BTC and a band
     * on a cheap alt are comparable, and so "the bands are tight" means the
     * same thing on both.
     */
    bandwidth: number;
    /**
     * Where the last close sits between the lower and upper band, 0 at the
     * lower one and 1 at the upper.
     *
     * Not clamped. A value outside 0..1 is real information — price is outside
     * the range, which is what a breakout looks like — and clamping it would
     * throw away the only moment this indicator has something to say.
     */
    percentB: number;
}

export function calculateBollingerBands(
    candles: Candle[],
    period: number,
    standardDeviations: number,
): BollingerBands {
    if (candles.length === 0) {
        throw new Error('Bollinger Bands require at least one candle');
    }

    if (period <= 1) {
        throw new Error('Bollinger Bands period must be greater than 1');
    }

    if (standardDeviations < 0) {
        throw new Error(
            'Bollinger Bands standard deviations must not be negative',
        );
    }

    if (candles.length < period) {
        throw new Error(`Bollinger Bands require at least ${period} candles`);
    }

    const window = candles
        .slice(-period)
        .map((candle) => candle.close);

    const middle =
        window.reduce((total, close) => total + close, 0) / window.length;

    // Population variance over the window, divided by the count rather than by
    // count - 1. Bollinger's original is a population standard deviation, and
    // using the sample one inflates the bands by a factor of sqrt(n/(n-1)) —
    // at period 20 that is a five percent wider band, which is a visible
    // difference and a silent one.
    const variance =
        window.reduce(
            (total, close) => total + (close - middle) ** 2,
            0,
        ) / window.length;

    const deviation = Math.sqrt(variance);
    const offset = deviation * standardDeviations;
    const upper = middle + offset;
    const lower = middle - offset;
    const last = candles[candles.length - 1];

    if (last === undefined) {
        throw new Error('Bollinger Bands require a closing price');
    }

    // A flat market has zero width, and then every close is also at both bands
    // and the ratio is a division by zero. The honest answer is the middle
    // band: price has not moved, so it is as central as it can be.
    const span = upper - lower;

    return {
        middle,
        upper,
        lower,
        bandwidth: middle === 0 ? 0 : span / middle,
        percentB: span === 0 ? 0.5 : (last.close - lower) / span,
    };
}
