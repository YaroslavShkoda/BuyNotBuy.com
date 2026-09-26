import type { MarketAnalysis } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import type { DivergenceAnalysis } from '../indicators/divergence.service.js';
import type { SignalResult } from '../signals/signal.types.js';

import { getMarketData } from '../market/market.service.js';
import { calculateMarketIndicators } from '../indicators/indicator.service.js';
import { calculateSignal } from '../signals/signal.service.js';
import { calculateMomentumSeries } from '../indicators/momentum-series.js';
import { analyzeDivergence } from '../indicators/divergence.service.js';
import { recordSignalHistory } from '../history/signal-history.service.js';
import { recordIndicatorVotes } from '../indicators/performance/indicator-performance.service.js';
import { marketConfig } from '../config/market.config.js';
import {
    indicatorConfig,
    INDICATOR_SIGNAL_CONFIG,
} from '../config/indicator.config.js';
import {
    attachAnalysisErrorContext,
    buildAnalysisTelemetry,
    measureAsync,
    measureSync,
} from './analysis.telemetry.js';

import type { AnalysisFailedStage, AnalysisTelemetryLogger } from './analysis.telemetry.js';
import type { SignalHistoryLogger } from '../history/signal-history.types.js';

const MOMENTUM_PERIOD = indicatorConfig.momentumPeriod;

export interface AnalysisWithStatus {
    analysis: MarketAnalysis;
    /** The market snapshot behind this analysis was reused after a failure. */
    stale: boolean;
    ageMs: number;
}

export async function analyzeMarket(
    logger?: AnalysisTelemetryLogger,
    requestId?: string,
    historyLogger?: SignalHistoryLogger,
): Promise<MarketAnalysis> {
    const { analysis } = await analyzeMarketWithStatus(
        logger,
        requestId,
        historyLogger,
    );

    return analysis;
}

/**
 * Same analysis, plus the freshness of the market snapshot it was computed
 * from. The analysis itself is never cached: indicators, signal and divergence
 * are pure functions of the candles and cost fractions of a millisecond, so
 * only the network fetch is worth holding on to.
 */
export async function analyzeMarketWithStatus(
    logger?: AnalysisTelemetryLogger,
    requestId?: string,
    historyLogger?: SignalHistoryLogger,
): Promise<AnalysisWithStatus> {
    const totalStart = performance.now();
    const completedDurations: {
        marketDataDurationMs?: number;
        indicatorsDurationMs?: number;
        divergenceDurationMs?: number;
        signalDurationMs?: number;
    } = {};

    const fail = (
        error: unknown,
        failedStage: AnalysisFailedStage,
    ): never => {
        attachAnalysisErrorContext(error, {
            totalDurationMs: performance.now() - totalStart,
            failedStage,
            ...completedDurations,
            ...(requestId !== undefined ? { requestId } : {}),
        });

        throw error;
    };

    let marketData: MarketData;
    let marketDataStale = false;
    let marketDataAgeMs = 0;

    try {
        const marketDataMeasured = await measureAsync(
            () => getMarketData(),
        );

        marketData = marketDataMeasured.result.data;
        marketDataStale = marketDataMeasured.result.stale;
        marketDataAgeMs = marketDataMeasured.result.ageMs;
        completedDurations.marketDataDurationMs = marketDataMeasured.durationMs;
    } catch (error) {
        fail(error, 'market-data');
        throw error;
    }

    let indicators: MarketIndicators;
    try {
        const indicatorsMeasured = measureSync(() => calculateMarketIndicators(
            marketData,
        ));
        indicators = indicatorsMeasured.result;
        completedDurations.indicatorsDurationMs = indicatorsMeasured.durationMs;
    } catch (error) {
        fail(error, 'indicators');
        throw error;
    }

    const momentumSeries = calculateMomentumSeries(
        marketData.candles,
        MOMENTUM_PERIOD,
    );
    let divergence: DivergenceAnalysis;
    try {
        const divergenceMeasured = measureSync(() => analyzeDivergence(
            marketData.candles,
            {
                momentumPeriod: MOMENTUM_PERIOD,
                momentumSeries,
            },
        ));
        divergence = divergenceMeasured.result;
        completedDurations.divergenceDurationMs = divergenceMeasured.durationMs;
    } catch (error) {
        fail(error, 'divergence');
        throw error;
    }

    let signal: SignalResult;
    try {
        const signalMeasured = measureSync(() => calculateSignal(
            marketData.price.price,
            indicators,
            // The EMA vote needs several consecutive closes on one side, not
            // just the latest print, so it cannot be read off a single value.
            marketData.candles
                .slice(-(INDICATOR_SIGNAL_CONFIG.ema.confirmBars + 1))
                .map((candle) => candle.close),
        ));
        signal = signalMeasured.result;
        completedDurations.signalDurationMs = signalMeasured.durationMs;
    } catch (error) {
        fail(error, 'signal');
        throw error;
    }

    const marketDataDurationMs = completedDurations.marketDataDurationMs ?? 0;
    const indicatorsDurationMs = completedDurations.indicatorsDurationMs ?? 0;
    const divergenceDurationMs = completedDurations.divergenceDurationMs ?? 0;
    const signalDurationMs = completedDurations.signalDurationMs ?? 0;

    const analysis: MarketAnalysis = {
        timestamp: Date.now(),
        price: marketData.price.price,
        indicators,
        signal,
        momentum: {
            period: MOMENTUM_PERIOD,
            current: indicators.momentum,
            series: momentumSeries,
        },
        divergence,
        periods: {
            ema: indicatorConfig.emaPeriod,
            stochastic: indicatorConfig.stochasticPeriod,
            momentum: indicatorConfig.momentumPeriod,
            atr: indicatorConfig.atrPeriod,
            rsi: indicatorConfig.rsiPeriod,
            macdFast: indicatorConfig.macdFastPeriod,
            macdSlow: indicatorConfig.macdSlowPeriod,
            macdSignal: indicatorConfig.macdSignalPeriod,
        },
    };

    logger?.info(
        buildAnalysisTelemetry(
            analysis,
            {
                marketDataDurationMs,
                indicatorsDurationMs,
                divergenceDurationMs,
                signalDurationMs,
                totalDurationMs: performance.now() - totalStart,
            },
            {
                provider: marketConfig.provider,
                symbol: marketData.price.symbol,
                candleCount: marketData.candles.length,
                candleInterval: marketConfig.candleInterval,
                ...(marketDataStale
                    ? { dataStale: true, dataAgeMs: marketDataAgeMs }
                    : {}),
                ...(requestId !== undefined ? { requestId } : {}),
            },
        ),
        'market_analysis_completed',
    );

    // Non-critical side effect: every successful analysis is recorded into
    // signal history, but a persistence failure must never fail the analysis
    // response (recordSignalHistory is fail-open by contract).
    recordSignalHistory(
        {
            timestamp: analysis.timestamp,
            symbol: marketData.price.symbol,
            signal: analysis.signal.signal,
            consensus: analysis.signal.confidence,
            price: analysis.price,
        },
        historyLogger,
    );

    // The consensus is one number that hides its inputs, so each indicator's
    // own vote is stored next to it. This is what later answers "was the EMA
    // actually right?" instead of leaving it a matter of faith. Also
    // fail-open, and it does not belong in the response either way.
    recordIndicatorVotes(analysis, marketData.price.symbol);

    return { analysis, stale: marketDataStale, ageMs: marketDataAgeMs };
}
