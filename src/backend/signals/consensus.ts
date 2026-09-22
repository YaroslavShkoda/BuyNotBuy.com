import type { IndicatorAnalysis, SignalResult } from './signal.types';

export function calculateConsensus(
    analyses: IndicatorAnalysis[],
): Omit<SignalResult, 'indicators'> {
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
                reason:
                    longAnalyses
                        .map((analysis) => analysis.name)
                        .join(' и ') +
                    ' подтверждают LONG',
            };
        }

        const names = longAnalyses
            .map((analysis) => analysis.name)
            .join(' и ');

        return {
            signal: 'LONG',
            confidence: 50,
            reason:
                'Только ' +
                names +
                (longAnalyses.length === 1
                    ? ' подтверждает LONG'
                    : ' подтверждают LONG'),
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
                reason:
                    shortAnalyses
                        .map((analysis) => analysis.name)
                        .join(' и ') +
                    ' подтверждают SHORT',
            };
        }

        const names = shortAnalyses
            .map((analysis) => analysis.name)
            .join(' и ');

        return {
            signal: 'SHORT',
            confidence: 50,
            reason:
                'Только ' +
                names +
                (shortAnalyses.length === 1
                    ? ' подтверждает SHORT'
                    : ' подтверждают SHORT'),
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
