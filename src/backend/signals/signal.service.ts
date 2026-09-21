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

function combineSignals(
    analyses: IndicatorAnalysis[],
): Pick<
    SignalResult,
    'signal' | 'confidence' | 'reason'
> {
    const longCount = analyses.filter(
        (analysis) => analysis.signal === 'LONG',
    ).length;

    const shortCount = analyses.filter(
        (analysis) => analysis.signal === 'SHORT',
    ).length;

    const neutralCount = analyses.filter(
        (analysis) => analysis.signal === 'NEUTRAL',
    ).length;

    if (
        longCount > 0 &&
        shortCount === 0
    ) {
        if (neutralCount === 0) {
            return {
                signal: 'LONG',
                confidence: 100,
                reason: 'EMA 300 и Стохастик подтверждают LONG',
            };
        }

        const activeIndicator = analyses.find(
            (analysis) => analysis.signal === 'LONG',
        );

        return {
            signal: 'LONG',
            confidence: 50,
            reason: `Только ${activeIndicator?.name} подтверждает LONG`,
        };
    }

    if (
        shortCount > 0 &&
        longCount === 0
    ) {
        if (neutralCount === 0) {
            return {
                signal: 'SHORT',
                confidence: 100,
                reason: 'EMA 300 и Стохастик подтверждают SHORT',
            };
        }

        const activeIndicator = analyses.find(
            (analysis) => analysis.signal === 'SHORT',
        );

        return {
            signal: 'SHORT',
            confidence: 50,
            reason: `Только ${activeIndicator?.name} подтверждает SHORT`,
        };
    }

    if (
        longCount > 0 &&
        shortCount > 0
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

    return combineSignals([
        emaAnalysis,
        stochasticAnalysis,
    ]);
}
