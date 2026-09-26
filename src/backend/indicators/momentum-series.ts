import type { Candle } from '../types/market.js';

export function calculateMomentumSeries(
    candles: Candle[],
    period: number,
): Array<number | null> {
    if (candles.length === 0) {
        throw new Error('Momentum series requires at least one candle');
    }

    if (period <= 0) {
        throw new Error('Momentum period must be greater than 0');
    }

    return candles.map((candle, index) => {
        if (index < period) {
            return null;
        }

        const previousCandle = candles[index - period];

        if (previousCandle === undefined) {
            throw new Error('Momentum series requires at least one candle');
        }

        const previousClose = previousCandle.close;

        if (previousClose === 0) {
            return null;
        }

        return ((candle.close - previousClose) / previousClose) * 100;
    });
}
