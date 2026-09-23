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

    if (longAnalyses.length === shortAnalyses.length) {
        return {
            signal: 'NEUTRAL',
            confidence: 0,
            reason: longAnalyses.length > 0
                ? 'Индикаторы дают противоположные сигналы'
                : 'Ни один индикатор не даёт сигнала',
        };
    }

    const winningAnalyses = longAnalyses.length > shortAnalyses.length
        ? longAnalyses
        : shortAnalyses;
    const winningSignal = longAnalyses.length > shortAnalyses.length
        ? 'LONG'
        : 'SHORT';
    const confidence = analyses.length === 0
        ? 0
        : Math.round((winningAnalyses.length / analyses.length) * 100);
    const names = winningAnalyses
        .map((analysis) => analysis.name)
        .join(' и ');
    const verb = winningAnalyses.length === 1
        ? 'подтверждает'
        : 'подтверждают';
    const only = neutralCount > 0 &&
        (winningSignal === 'LONG' ? shortAnalyses.length : longAnalyses.length) === 0
        ? 'Только '
        : '';

    return {
        signal: winningSignal,
        confidence,
        reason: `${only}${names} ${verb} ${winningSignal}`,
    };
}
