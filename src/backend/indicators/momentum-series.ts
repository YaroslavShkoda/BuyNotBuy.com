import type { Candle } from '../types/market';

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

        return candle.close - previousCandle.close;
    });
}
