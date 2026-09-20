import type { MarketIndicators } from '../indicators/indicator.service';

import type {
    IndicatorAnalysis,
    IndicatorSignal,
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
            signal: 'LONG',
            reason: 'Цена выше EMA 300',
        };
    }

    if (price < ema300) {
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

function analyzeStochastic(
    stochastic: number,
): IndicatorAnalysis {
    if (stochastic < STOCHASTIC_LONG_THRESHOLD) {
        return {
            signal: 'LONG',
            reason: 'Стохастик ниже 15',
        };
    }

    if (stochastic > STOCHASTIC_SHORT_THRESHOLD) {
        return {
            signal: 'SHORT',
            reason: 'Стохастик выше 80',
        };
    }

    return {
        signal: 'NEUTRAL',
        reason: 'Стохастик находится в нейтральной зоне',
    };
}

function combineSignals(
    emaSignal: IndicatorSignal,
    stochasticSignal: IndicatorSignal,
): Pick<SignalResult, 'signal' | 'confidence' | 'reason'> {
    if (emaSignal === 'LONG' && stochasticSignal === 'LONG') {
        return {
            signal: 'LONG',
            confidence: 100,
            reason: 'EMA 300 и Стохастик подтверждают LONG',
        };
    }

    if (emaSignal === 'SHORT' && stochasticSignal === 'SHORT') {
        return {
            signal: 'SHORT',
            confidence: 100,
            reason: 'EMA 300 и Стохастик подтверждают SHORT',
        };
    }

    if (emaSignal === 'LONG' && stochasticSignal === 'NEUTRAL') {
        return {
            signal: 'LONG',
            confidence: 50,
            reason: 'Только EMA 300 подтверждает LONG',
        };
    }

    if (emaSignal === 'NEUTRAL' && stochasticSignal === 'LONG') {
        return {
            signal: 'LONG',
            confidence: 50,
            reason: 'Только Стохастик подтверждает LONG',
        };
    }

    if (emaSignal === 'SHORT' && stochasticSignal === 'NEUTRAL') {
        return {
            signal: 'SHORT',
            confidence: 50,
            reason: 'Только EMA 300 подтверждает SHORT',
        };
    }

    if (emaSignal === 'NEUTRAL' && stochasticSignal === 'SHORT') {
        return {
            signal: 'SHORT',
            confidence: 50,
            reason: 'Только Стохастик подтверждает SHORT',
        };
    }

    if (
        (emaSignal === 'LONG' && stochasticSignal === 'SHORT') ||
        (emaSignal === 'SHORT' && stochasticSignal === 'LONG')
    ) {
        return {
            signal: 'NEUTRAL',
            confidence: 50,
            reason: 'Индикаторы дают противоположные сигналы',
        };
    }

    return {
        signal: 'NEUTRAL',
        confidence: 0,
        reason: 'Ни один индикатор не даёт сигнала',
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

    return combineSignals(
        emaAnalysis.signal,
        stochasticAnalysis.signal,
    );
}