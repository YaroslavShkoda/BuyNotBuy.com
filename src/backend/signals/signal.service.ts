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
    const longAnalyses = analyses.filter(
        (analysis) => analysis.signal === 'LONG',
    );

    const shortAnalyses = analyses.filter(
        (analysis) => analysis.signal === 'SHORT',
    );

    const neutralCount = analyses.filter(
        (analysis) => analysis.signal === 'NEUTRAL',
    ).length;

    if (
        longAnalyses.length > 0 &&
        shortAnalyses.length === 0
    ) {
        if (neutralCount === 0) {
            return {
                signal: 'LONG',
                confidence: 100,
                reason: longAnalyses
                    .map((analysis) => analysis.name)
                    .join(' и ') +
                    ' подтверждают LONG',
            };
        }

        return {
            signal: 'LONG',
            confidence: 50,
            reason: `Только ${longAnalyses[0].name} подтверждает LONG`,
        };
    }

    if (
        shortAnalyses.length > 0 &&
        longAnalyses.length === 0
    ) {
        if (neutralCount === 0) {
            return {
                signal: 'SHORT',
                confidence: 100,
                reason: shortAnalyses
                    .map((analysis) => analysis.name)
                    .join(' и ') +
                    ' подтверждают SHORT',
            };
        }

        return {
            signal: 'SHORT',
            confidence: 50,
            reason: `Только ${shortAnalyses[0].name} подтверждает SHORT`,
        };
    }

    if (
        longAnalyses.length > 0 &&
        shortAnalyses.length > 0
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

    const result = combineSignals([
        emaAnalysis,
        stochasticAnalysis,
    ]);

    return {
        ...result,
        indicators: [
            emaAnalysis,
            stochasticAnalysis,
        ],
    };
}



