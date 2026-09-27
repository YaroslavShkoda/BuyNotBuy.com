import type { MarketAnalysis } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import type { DivergenceAnalysis } from '../indicators/divergence.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import { recordPublishedSignal } from '../signals/signal-publication.js';

import { getMarketData } from '../market/market.service.js';
import { calculateMarketIndicators, toWireIndicators } from '../indicators/indicator.service.js';
import { calculateSignal } from '../signals/signal.service.js';
import { calculateMomentumSeries } from '../indicators/momentum-series.js';
import { analyzeDivergence } from '../indicators/divergence.service.js';
import { recordSignalHistory } from '../history/signal-history.service.js';
import { recordIndicatorVotes } from '../indicators/performance/indicator-performance.service.js';
import { getSignalSnapshotRepository } from '../analysis/signal-snapshot.repository.js';
import { getStrategyVersionRepository } from '../analysis/strategy-version.repository.js';
import { marketConfig } from '../config/market.config.js';
import { assessDataQuality } from '../history/data-quality.js';
import { assessRegime } from '../indicators/regime.js';
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
import type { MarketFreshness } from '../market/market-freshness.js';
import type { SignalHistoryLogger } from '../history/signal-history.types.js';
import type { SignalContext } from '../history/signal-history.types.js';

const MOMENTUM_PERIOD = indicatorConfig.momentumPeriod;

export interface AnalysisWithStatus {
    analysis: MarketAnalysis;
    /** The market snapshot behind this analysis was reused after a failure. */
    stale: boolean;
    ageMs: number;
    /** Which of the six freshness states that snapshot is in. */
    freshness: MarketFreshness;
    /** Which venue actually produced it. */
    provider: string;
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
    let marketFreshness: MarketFreshness = 'fresh';
    let marketProvider: string = marketConfig.provider;

    try {
        const marketDataMeasured = await measureAsync(
            () => getMarketData(),
        );

        marketData = marketDataMeasured.result.data;
        marketDataStale = marketDataMeasured.result.stale;
        marketDataAgeMs = marketDataMeasured.result.ageMs;
        marketFreshness = marketDataMeasured.result.freshness;
        marketProvider = marketDataMeasured.result.provider;
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
        indicators: toWireIndicators(indicators),
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

    // Counted where the signal is *published*, not inside `calculateSignal`.
    // That function is pure arithmetic called by hundreds of tests with
    // invented prices, and a counter it moved would measure the test suite
    // rather than the system. Here, one counter tick is one signal a caller
    // was actually given.
    recordPublishedSignal(signal.signal);

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
                provider: marketProvider,
                symbol: marketData.price.symbol,
                candleCount: marketData.candles.length,
                candleInterval: marketConfig.candleInterval,
                marketTimestamp: marketData.timestamp,
                // The state, not just the boolean. "Stale" covers a snapshot
                // behind the market and a snapshot that is current while the
                // feed is dead, and those two call for different responses.
                freshness: marketFreshness,
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
    //
    // Deliberately not awaited. Against a file that cost was invisible; against
    // a database on the network it is a round trip, and awaiting it would turn
    // "fail open" into "fail slow" — a database that is down would add its
    // connect timeout to every page load instead of only to the history. Both
    // calls swallow their own errors, so the discarded promise cannot reject
    // into an unhandled rejection.
    // The market these numbers were produced in. A performance table grouped by
    // regime is the whole reason this column exists, and without it every
    // signal looks like it came from the same market.
    const context = analysisContext(marketData, analysis.timestamp);

    void recordSignalHistory(
        {
            timestamp: analysis.timestamp,
            symbol: marketData.price.symbol,
            signal: analysis.signal.signal,
            consensus: analysis.signal.confidence,
            price: analysis.price,
            // Conditional rather than assigned undefined: an absent context is a
            // fact, and writing one is how a table ends up full of nulls that
            // look like a failed write.
            ...(context === undefined ? {} : { context }),
        },
        historyLogger,
    );

    // The consensus is one number that hides its inputs, so each indicator's
    // own vote is stored next to it. This is what later answers "was the EMA
    // actually right?" instead of leaving it a matter of faith. Also
    // fail-open, and it does not belong in the response either way.
    void recordIndicatorVotes(analysis, marketData.price.symbol);

    // The full analysis, stored immutably, under the version of the strategy
    // that produced it.
    //
    // This is the record every later stage of the pipeline is measured
    // against. The summary history and the votes can only say what the signal
    // was; they cannot say what the indicators were, what the inputs looked
    // like, or which configuration produced them. Without that, a hit rate
    // measured today cannot be re-derived tomorrow, and the chain from
    // signal to outcome to statistics has nothing to be attached to.
    //
    // Fire-and-forget for the same reason as the two calls above: a
    // persistence failure must not become a slow page load. It is idempotent
    // on the input hash, so a retry cannot produce a second copy.
    void storeSnapshot(analysis, marketData, historyLogger).catch(() => undefined);

    return {
        analysis,
        stale: marketDataStale,
        ageMs: marketDataAgeMs,
        freshness: marketFreshness,
        provider: marketProvider,
    };
}

/**
 * Writes one immutable snapshot, resolving its strategy version first.
 *
 * Split out so the version lookup — a write, not a read — happens on the same
 * detached promise as the insert, and so a failure to resolve a version is
 * logged rather than lost in a discarded rejection.
 */
/**
 * The market the signal was produced in, for the history.
 *
 * Both assessments are wrapped: a signal that was published is a signal the
 * system stands behind, and a regime or a quality score is context, not a gate.
 * Losing the context on a series too short to assess it is correct; failing to
 * record a signal that was correctly produced is not. The whole thing is
 * therefore best-effort and returns null rather than propagating.
 */
function analysisContext(
    marketData: MarketData,
    now: number,
): SignalContext | undefined {
    try {
        const quality = assessDataQuality({
            candles: marketData.candles,
            now,
            intervalMs: marketConfig.candleIntervalMs,
            provider: marketData.provider,
        });
        const regime = assessRegime({ candles: marketData.candles });

        return {
            regime: regime.unreliable === null
                ? `${regime.volatility}/${regime.trend}`
                : `${regime.volatility}/${regime.trend} (${regime.unreliable})`,
            dataQuality: quality.score,
            dataQualityUsable: quality.usable,
            dataQualityWorst: quality.worst,
        };
    } catch {
        return undefined;
    }
}

async function storeSnapshot(
    analysis: MarketAnalysis,
    marketData: MarketData,
    logger?: SignalHistoryLogger,
): Promise<void> {
    try {
        const strategyVersion = await getStrategyVersionRepository().resolveActive();

        const stored = await getSignalSnapshotRepository().record({
            symbol: marketData.price.symbol,
            strategyVersion,
            price: analysis.price,
            candles: marketData.candles,
            snapshot: analysis,
        });

        logger?.debug?.(
            {
                event: 'signal_snapshot_stored',
                snapshotId: stored.id,
                strategyVersionId: strategyVersion.id,
                deduplicated: !stored.created,
            },
            'signal_snapshot_stored',
        );
    } catch (error) {
        logger?.warn(
            { event: 'signal_snapshot_store_failed', err: error },
            'signal_snapshot_store_failed',
        );
    }
}
