import { Candle } from '../types/market';

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

    const higestHigh = Math.max(
        ...recentCandles.map((candle) => candle.high),
    );

    const lowestLow = Math.min(
        ...recentCandles.map((candle) => candle.low),
    );

    const currentClose = recentCandles[recentCandles.length - 1].close;

    if (higestHigh === lowestLow) {
        throw new Error('Stochastic cannot be calculated when highest high equals lowest low');
    }

    return(
        ((currentClose - lowestLow) / (higestHigh - lowestLow)) * 100
    );
}