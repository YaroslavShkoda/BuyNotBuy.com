import type {
    MarketAnalysis,
} from '../types/analysis.js';

import type {
    IndicatorSignal,
} from '../signals/signal.types.js';

import type { MarketFreshness } from '../market/market-freshness.js';

export interface AnalysisTelemetryLogger {
    info(
        context: AnalysisTelemetry,
        message: string,
    ): void;
}

export interface AnalysisStageDurations {
    marketDataDurationMs: number;
    indicatorsDurationMs: number;
    divergenceDurationMs: number;
    signalDurationMs: number;
    totalDurationMs: number;
}

export type AnalysisTelemetry = AnalysisStageDurations & {
    event: 'market_analysis_completed';
    provider: string;
    symbol: string;
    candleCount: number;
    candleInterval: string;
    /** Close of the newest candle, i.e. the market's own clock. */
    marketTimestamp: number;
    /**
     * Which of the six freshness states the snapshot behind this analysis is.
     *
     * A field rather than only the `dataStale` boolean, because the two answer
     * different questions: `dataStale` says "not freshly fetched", this says
     * why. A dashboard degraded to a cached snapshot and one whose market feed
     * is entirely dead both answer "true" to the first and are different
     * incidents.
     */
    freshness: MarketFreshness;
    signal: IndicatorSignal;
    confidence: number;
    requestId?: string;
};

export type AnalysisFailedStage =
    | 'market-data'
    | 'indicators'
    | 'divergence'
    | 'signal';

export interface AnalysisErrorContext {
    totalDurationMs: number;
    failedStage: AnalysisFailedStage;
    marketDataDurationMs?: number;
    indicatorsDurationMs?: number;
    divergenceDurationMs?: number;
    signalDurationMs?: number;
    requestId?: string;
}

const ANALYSIS_ERROR_CONTEXT_KEY = 'analysisDiagnostics';

export function attachAnalysisErrorContext(
    error: unknown,
    context: AnalysisErrorContext,
): void {
    if (
        typeof error !== 'object' ||
        error === null
    ) {
        return;
    }

    (error as Record<string, unknown>)[ANALYSIS_ERROR_CONTEXT_KEY] = context;
}

export function readAnalysisErrorContext(
    error: unknown,
): AnalysisErrorContext | undefined {
    if (
        typeof error !== 'object' ||
        error === null ||
        !(ANALYSIS_ERROR_CONTEXT_KEY in error)
    ) {
        return undefined;
    }

    return (error as Record<string, AnalysisErrorContext | undefined>)[
        ANALYSIS_ERROR_CONTEXT_KEY
    ];
}

export function measureSync<T>(
    operation: () => T,
): { result: T; durationMs: number } {
    const start = performance.now();
    const result = operation();

    return {
        result,
        durationMs: performance.now() - start,
    };
}

export async function measureAsync<T>(
    operation: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
    const start = performance.now();
    const result = await operation();

    return {
        result,
        durationMs: performance.now() - start,
    };
}

export function buildAnalysisTelemetry(
    analysis: MarketAnalysis,
    durations: AnalysisStageDurations,
    context: {
        provider: string;
        symbol: string;
        candleCount: number;
        candleInterval: string;
        marketTimestamp: number;
        freshness: MarketFreshness;
        requestId?: string;
    },
): AnalysisTelemetry {
    return {
        event: 'market_analysis_completed',
        provider: context.provider,
        symbol: context.symbol,
        candleCount: context.candleCount,
        candleInterval: context.candleInterval,
        marketTimestamp: context.marketTimestamp,
        freshness: context.freshness,
        marketDataDurationMs: durations.marketDataDurationMs,
        indicatorsDurationMs: durations.indicatorsDurationMs,
        divergenceDurationMs: durations.divergenceDurationMs,
        signalDurationMs: durations.signalDurationMs,
        totalDurationMs: durations.totalDurationMs,
        signal: analysis.signal.signal,
        confidence: analysis.signal.confidence,
        ...(context.requestId !== undefined
            ? { requestId: context.requestId }
            : {}),
    };
}
