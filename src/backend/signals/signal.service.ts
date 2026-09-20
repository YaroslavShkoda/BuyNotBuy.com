import type { MarketIndicators } from '../indicators/indicator.service';

export type MarketSignal =
    | 'LONG'
    | 'SHORT'
    | 'NEUTRAL';

export interface SignalResult {
    signal: MarketSignal;
    reason: string;
}

const EMA_ZONE_PERCENT = 0.5;

export function calculateSignal(
    price: number,
    indicators: MarketIndicators,
): SignalResult {
    const ema300 = indicators.ema300;

    const zone = ema300 * (EMA_ZONE_PERCENT / 100);

    const lowerBound = ema300 - zone;
    const upperBound = ema300 + zone;

    if (price > upperBound) {
        return {
            signal: 'LONG',
            reason: 'Цена выше EMA 300',
        };
    }

    if (price < lowerBound) {
        return {
            signal: 'SHORT',
            reason: 'Цена ниже EMA 300',
        };
    }

    return {
        signal: 'NEUTRAL',
        reason: 'Цена находится на уровне EMA 300',
    };
}