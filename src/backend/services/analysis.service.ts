import type { MarketAnalysis } from '../types/analysis';
import type { MarketData } from '../types/market';
import type { MarketIndicators } from '../indicators/indicator.service';
import type { DivergenceAnalysis } from '../indicators/divergence.service';
import type { SignalResult } from '../signals/signal.types';

import { getMarketData } from '../market/market.service';
import { calculateMarketIndicators } from '../indicators/indicator.service';
import { calculateSignal } from '../signals/signal.service';
import { calculateMomentumSeries } from '../indicators/momentum-series';
import { analyzeDivergence } from '../indicators/divergence.service';
import { marketConfig } from '../config/market.config';
import {
    attachAnalysisErrorContext,
    buildAnalysisTelemetry,
    measureAsync,
    measureSync,
} from './analysis.telemetry';

import type { AnalysisFailedStage, AnalysisTelemetryLogger } from './analysis.telemetry';

const MOMENTUM_PERIOD = 100;

export async function analyzeMarket(
    logger?: AnalysisTelemetryLogger,
    requestId?: string,
): Promise<MarketAnalysis> {
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
    try {
        const marketDataMeasured = await measureAsync(() => getMarketData());
        marketData = marketDataMeasured.result;
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
            MOMENTUM_PERIOD,
            2,
            2,
            5,
            momentumSeries,
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
                ...(requestId !== undefined ? { requestId } : {}),
            },
        ),
        'market_analysis_completed',
    );

    return analysis;
}
