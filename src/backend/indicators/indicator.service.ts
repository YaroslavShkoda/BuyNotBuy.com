import type { MarketData } from '../types/market';

import { calculateEMA } from './ema';
import { calculateStochastic } from './stochastic';
import { calculateMomentum } from './momentum';

const EMA_PERIOD = 300;
const STOCHASTIC_PERIOD = 100;
const MOMENTUM_PERIOD = 100;

export interface MarketIndicators {
    ema300: number;
    stochastic: number;
    momentum: number;
}

export function calculateMarketIndicators(
    marketData: MarketData,
): MarketIndicators {
    const closePrices = marketData.candles.map(
        (candle) => candle.close,
    );

    const ema300 = calculateEMA(
        closePrices,
        EMA_PERIOD,
    );

    const stochastic = calculateStochastic(
        marketData.candles,
        STOCHASTIC_PERIOD,
    );

    const momentum = calculateMomentum(
        marketData.candles,
        MOMENTUM_PERIOD,
    );

    return {
        ema300,
        stochastic,
        momentum,
    };
}