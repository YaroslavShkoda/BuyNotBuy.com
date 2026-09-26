import type { Candle } from '../types/market.js';

export function calculateStochastic(
    candles: Candle[],
    period: number,
): number {
    if (candles.length === 0) {
        throw new Error('Stochastic requires at least one candle');
    }

    if (period <= 0) {
        throw new Error('Stochastic period must be greater than 0');
    }

    if (candles.length < period) {
        throw new Error(`Stochastic requires at least ${period} candles`);
    }

    const recentCandles = candles.slice(-period);

    const highestHigh = Math.max(
        ...recentCandles.map((candle) => candle.high),
    );

    const lowestLow = Math.min(
        ...recentCandles.map((candle) => candle.low),
    );

    const currentCandle = recentCandles[recentCandles.length - 1];

    if (currentCandle === undefined) {
        throw new Error(`Stochastic requires at least ${period} candles`);
    }

    const currentClose = currentCandle.close;

    if (highestHigh === lowestLow) {
        throw new Error('Stochastic cannot be calculated when highest high equals lowest low');
    }

    return(
        ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100
    );
}