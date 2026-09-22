import type { Candle } from '../types/market';

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

    const currentClose =
        candles[candles.length - 1].close;

    const previousClose =
        candles[candles.length - 1 - period].close;

    return currentClose - previousClose;
}
