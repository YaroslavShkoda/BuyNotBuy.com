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

    /**
     * Required rather than optional.
     *
     * The analysis decides several things are not fatal, and every one of those
     * decisions is a place where an error can stop being recorded. A logger that
     * could only report successes has no way to say "this ran, and part of it
     * did not work", which leaves two options and both are wrong: make the whole
     * run fail, or lose the failure. Requiring `error` means every implementation
     * has to decide where its failures go, and that decision is worth forcing.
     */
    error(
        context: FallbackFailureContext,
        message: string,
    ): void;
}

/**
 * A fallback that failed in a mode where its failure is not the run's failure.
 *
 * A shape of its own rather than a field on AnalysisTelemetry, because a
 * snapshot that completed has nowhere to put it — the whole point is that the
 * caller was given a valid answer. The record answers the question the run
 * itself cannot: has this optional path been broken for weeks, or since this
 * morning?
 */
export interface FallbackFailureContext {
    event: 'fallback_strategy_failed';
    /** The mode whose contract made this failure non-fatal. */
    mode: 'shadow' | 'off';
    /** Which strategy was supposed to be consulted. */
    strategy: string;
    /** True when the primary answer was kept and the run continued on it. */
    primaryAnswerKept: boolean;
    err: unknown;
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
    /**
     * Which rule produced the published signal.
     *
     * Present because a log line saying "NEUTRAL" no longer says everything
     * about how that NEUTRAL was reached: a fallback may have spoken, or may
     * have been overruled, or may not have been consulted at all.
     */
    signalRule: string;
    /**
     * True when a fallback had an opinion and was not allowed to publish it.
     *
     * The number the shadow period is read by. A fallback that is always
     * silent is a configuration nobody can tell from one that is not installed,
     * and this is what distinguishes them in the logs without a query.
     */
    fallbackSuppressed: boolean;
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
        signalRule: string;
        fallbackSuppressed: boolean;
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
        signalRule: context.signalRule,
        fallbackSuppressed: context.fallbackSuppressed,
        ...(context.requestId !== undefined
            ? { requestId: context.requestId }
            : {}),
    };
}
