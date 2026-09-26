import type { Candle } from '../types/market.js';

export function calculateMomentum(
    candles: Candle[],
    period: number,
): number {
    if (candles.length === 0) {
        throw new Error(
            'Momentum requires at least one candle',
        );
    }

    if (period <= 0) {
        throw new Error(
            'Momentum period must be greater than 0',
        );
    }

    if (candles.length <= period) {
        throw new Error(
            `Momentum requires at least ${period + 1} candles`,
        );
    }

    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 1 - period];

    if (currentCandle === undefined || previousCandle === undefined) {
        throw new Error(
            `Momentum requires at least ${period + 1} candles`,
        );
    }

    const currentClose = currentCandle.close;

    const previousClose = previousCandle.close;

    return percentageChange(previousClose, currentClose);
}

/**
 * Rate of change in percent, not an absolute price delta. An absolute delta
 * is neither scale-invariant nor stationary: the same 100-bar move reads ~5x
 * larger at $100k than at $20k, which makes momentum incomparable between
 * regimes and makes the divergence axis meaningless across instruments.
 */
function percentageChange(
    previousClose: number,
    currentClose: number,
): number {
    if (previousClose === 0) {
        throw new Error(
            'Momentum cannot be calculated against a zero base price',
        );
    }

    return ((currentClose - previousClose) / previousClose) * 100;
}
