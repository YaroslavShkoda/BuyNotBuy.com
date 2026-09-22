import type { MarketIndicators } from '../indicators/indicator.service';

import {
    calculateConsensus,
} from './consensus';

import type {
    IndicatorAnalysis,
    SignalResult,
} from './signal.types';

const STOCHASTIC_LONG_THRESHOLD = 15;
const STOCHASTIC_SHORT_THRESHOLD = 80;

function analyzeEMA(
    price: number,
    ema300: number,
): IndicatorAnalysis {
    if (price > ema300) {
        return {
            name: 'EMA 300',
            signal: 'LONG',
            reason: 'Цена выше EMA 300',
        };
    }

    if (price < ema300) {
        return {
            name: 'EMA 300',
            signal: 'SHORT',
            reason: 'Цена ниже EMA 300',
        };
    }

    return {
        name: 'EMA 300',
        signal: 'NEUTRAL',
        reason: 'Цена находится на уровне EMA 300',
    };
}

function analyzeStochastic(
    stochastic: number,
): IndicatorAnalysis {
    if (stochastic < STOCHASTIC_LONG_THRESHOLD) {
        return {
            name: 'Стохастик',
            signal: 'LONG',
            reason: 'Стохастик ниже 15',
        };
    }

    if (stochastic > STOCHASTIC_SHORT_THRESHOLD) {
        return {
            name: 'Стохастик',
            signal: 'SHORT',
            reason: 'Стохастик выше 80',
        };
    }

    return {
        name: 'Стохастик',
        signal: 'NEUTRAL',
        reason: 'Стохастик находится в нейтральной зоне',
    };
}

export function calculateSignal(
    price: number,
    indicators: MarketIndicators,
): SignalResult {
    const emaAnalysis = analyzeEMA(
        price,
        indicators.ema300,
    );

    const stochasticAnalysis = analyzeStochastic(
        indicators.stochastic,
    );

    const indicatorAnalyses = [
        emaAnalysis,
        stochasticAnalysis,
    ];

    const consensus = calculateConsensus(
        indicatorAnalyses,
    );

    return {
        ...consensus,
        indicators: indicatorAnalyses,
    };
}
