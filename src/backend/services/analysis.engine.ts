import { indicatorConfig, signalConfigFor } from '../config/indicator.config.js';
import { marketConfig } from '../config/market.config.js';
import { assessDataQuality } from '../history/data-quality.js';
import type { SignalContext } from '../history/signal-history.types.js';
import type { DivergenceAnalysis } from '../indicators/divergence.service.js';
import { analyzeDivergence } from '../indicators/divergence.service.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import {
    calculateMarketIndicators,
    toWireIndicators,
} from '../indicators/indicator.service.js';
import { calculateMomentumSeries } from '../indicators/momentum-series.js';
import { assessRegime } from '../indicators/regime.js';
import type { MarketRequest } from '../market/capability.js';
import { getMarketData } from '../market/market.service.js';
import type { MarketFreshness } from '../market/market-freshness.js';
import type { SignalExplanation } from '../signals/explanation.js';
import { calculateSignal } from '../signals/signal.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import type { ResolvedSignal } from '../strategies/registry.js';
import { createRegistry, readFallbackConfig, resolveSignal } from '../strategies/registry.js';
import type { MarketAnalysis } from '../types/analysis.js';
import type { Candle, MarketData } from '../types/market.js';
import { buildExplanation } from './analysis.explanation.js';
import type {
    AnalysisFailedStage,
    AnalysisTelemetry,
    FallbackFailureContext,
} from './analysis.telemetry.js';
import {
    attachAnalysisErrorContext,
    buildAnalysisTelemetry,
    measureAsync,
    measureSync,
} from './analysis.telemetry.js';

const MOMENTUM_PERIOD = indicatorConfig.momentumPeriod;

/**
 * The computation itself: fetch, indicators, divergence, signal, fallback.
 *
 * Split out of `analysis.service.ts`, which keeps the contract and the
 * workflow around it. This module computes and returns; everything that
 * writes anything anywhere — history rows, votes, snapshots, the decision
 * journal — lives in `analysis.persistence.ts` and is driven by the service
 * after the computation has returned.
 */
export interface MarketAnalysisStatus {
    /** The market snapshot behind this analysis was reused after a failure. */
    stale: boolean;
    ageMs: number;
    /** Which of the six freshness states that snapshot is in. */
    freshness: MarketFreshness;
    /** Which venue actually produced it. */
    provider: string;
}

/**
 * What one analysis costs and what it produced.
 *
 * The telemetry builders travel with the result rather than being called from
 * inside the computation, because those are per-caller and the computation is
 * shared. What the workflow's writes need — the market that answered, the
 * context that was measured once, both strategies' answers — travels with the
 * result for the same reason: bundling it here keeps the split in one place
 * instead of in the reader's head.
 */
export interface AnalysisComputation {
    readonly analysis: MarketAnalysis;
    readonly status: MarketAnalysisStatus;
    /**
     * True when the fallback would have changed the published signal and was
     * held back by shadow mode.
     *
     * Backend-only, and deliberately outside `MarketAnalysis`: the dashboard
     * contract is frozen, and this is a number about the system's own
     * confidence in its configuration rather than about the market. It is the
     * evidence the shadow period exists to collect.
     */
    readonly fallbackSuppressed: boolean;
    /** Built once per computation, beside the analysis it explains. */
    readonly explanation: SignalExplanation;
    /**
     * The market that answered, narrowed to what the writes downstream need.
     *
     * The history row, the votes and the snapshot all key on the market that
     * served the candles. Carrying the three fields they read means the
     * persistence layer never needs the whole `MarketData`.
     */
    readonly market: {
        readonly symbol: string;
        readonly candles: Candle[];
        readonly provider: string;
    };
    /**
     * The market as context, measured once and carried.
     *
     * The explanation and the history row need the same assessment, and
     * `analysisContext` costs two passes over the candles; measuring once and
     * passing it along is what keeps that at two passes, not four.
     */
    readonly context: SignalContext | undefined;
    /**
     * What both strategies said, or null when the resolution never happened.
     *
     * Null when the fallback failed in a mode where its failure was not the
     * run's failure. The decision journal is the workflow's write, and it
     * needs both answers; when there is no resolution there is nothing to
     * record, and the fallback-failure line each caller logs is the trace
     * that something was missed.
     */
    readonly resolved: ResolvedSignal | null;
    /** One context per caller, differing only in the request id. */
    telemetry(requestId?: string): AnalysisTelemetry;
    /**
     * The fallback failure this run survived, or null.
     *
     * Handed back rather than logged inside the computation because the
     * computation is shared and the logger is not: ten callers coalesce into
     * one run, and logging from inside it would file the failure under
     * whichever request happened to trigger this particular run, or under none.
     * Every caller gets the same answer and each one records it on its own
     * line, which is the same rule the telemetry line above already follows.
     */
    fallbackFailure(): FallbackFailureContext | null;
}

export async function computeAnalysis(
    request: MarketRequest,
): Promise<AnalysisComputation> {
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
        // No request id here. The computation is shared, so this context
        // belongs to the run rather than to whoever asked for it; each caller
        // stamps its own on the way out.
        attachAnalysisErrorContext(error, {
            totalDurationMs: performance.now() - totalStart,
            failedStage,
            ...completedDurations,
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
            // The market the caller named, not the configured one. Everything
            // downstream already keys on the market that answered — the
            // thresholds, the strategy version, the history rows — so this is the
            // one place that had no way to be told.
            () => getMarketData(request),
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

    // The thresholds in force for the market that actually answered, resolved
    // once and used by both the signal and the fallback below.
    //
    // `marketData.price.symbol` rather than the configured symbol: the market
    // layer routes by capability and refuses what no venue serves, so the market
    // in hand is the served one, and that is the market whose configuration a
    // signal and a strategy version have to agree about.
    const signalConfig = signalConfigFor(marketData.price.symbol);

    let signal: SignalResult;
    let fallbackSuppressed = false;
    let fallbackFailure: FallbackFailureContext | null = null;
    let publishedBy: string = 'consensus-primary';
    // Hoisted out of the try below so it can travel with the result: the
    // decision journal is written by the workflow, once per computation, and
    // this module no longer writes anything itself.
    let resolved: ResolvedSignal | null = null;
    try {
        const signalMeasured = measureSync(() => calculateSignal(
            marketData.price.price,
            indicators,
            // The EMA vote needs several consecutive closes on one side, not
            // just the latest print, so it cannot be read off a single value.
            marketData.candles
                .slice(-(signalConfig.ema.confirmBars + 1))
                .map((candle) => candle.close),
            signalConfig,
        ));
        signal = signalMeasured.result;
        completedDurations.signalDurationMs = signalMeasured.durationMs;
    } catch (error) {
        fail(error, 'signal');
        throw error;
    }

    // The fallback may only speak where the primary was silent, and by default
    // does not speak at all — it is evaluated, and the disagreement it would
    // have caused is counted. Turning that off is a deliberate act made after
    // watching, not the state a strategy arrives in.
    //
    // `indicators` is deliberately not touched. The dashboard renders that
    // array, and a fallback that appended a row would change what a frozen
    // client draws.
    try {
        // Built per computation rather than held in a singleton: the primary
        // is the existing consensus, which is defined over this run's
        // indicator readings, and those only exist here. A shared registry
        // would need them passed in from outside, which is a second route to
        // the indicators and therefore eventually two answers.
        const registry = createRegistry({
            consensus: (price, emaCloses) => {
                // The same thresholds the primary used. The fallback exists to
                // cover for the consensus, not to answer a different question,
                // and resolving the configuration twice would be one more place
                // for the two paths to disagree.
                const consensus = calculateSignal(price, indicators, emaCloses, signalConfig);

                return {
                    direction: consensus.signal,
                    confidence: consensus.confidence,
                    reason: consensus.reason,
                    warm: false,
                };
            },
            emaConfirmBars: signalConfig.ema.confirmBars,
        });

        resolved = resolveSignal(registry, {
            candles: marketData.candles,
            price: marketData.price.price,
        });

        fallbackSuppressed = resolved.suppressed;
        publishedBy = resolved.publishedBy;

        if (resolved.publishedBy !== 'consensus-primary') {
            signal = {
                signal: resolved.published.direction,
                confidence: resolved.published.confidence,
                reason: resolved.published.reason,
                // The panel still shows the indicators consulted before the
                // primary fell silent. A fallback verdict has no panel, and
                // inventing one would be a lie about where the answer came from.
                indicators: signal.indicators,
            };
        }
    } catch (error) {
        // Fatal only when the fallback was actually going to change the
        // answer. In shadow it is not authoritative, so its failure is not the
        // analysis's failure, and discarding a valid primary answer because an
        // optional strategy threw would turn an enhancement into a dependency.
        const fallback = readFallbackConfig();

        if (fallback.mode === 'active') {
            fail(error, 'signal');
        }

        // Kept, not logged, and not thrown: the decision above is right, and
        // acting on the failure would turn an enhancement into a dependency.
        // What was missing was the record. Every run in this mode looks exactly
        // like every other one — the answer is right, the log is clean, and
        // nothing anywhere says the enhancement the deployment was configured to
        // evaluate has not been evaluating anything. Silent degradation is
        // indistinguishable from quiet health, and the entire point of running
        // a fallback in shadow is to find out whether it works.
        if (fallback.mode !== 'active') {
            fallbackFailure = {
                event: 'fallback_strategy_failed',
                mode: fallback.mode,
                strategy: fallback.key,
                primaryAnswerKept: true,
                err: error,
            };
        }
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
    // rather than the system. The tick happens per caller, in the service.

    // Measured once, for both the explanation and the history row. It was
    // already unconditional inside `writeHistory`; moving it here is what lets
    // the explanation carry the market's own condition without asking for it a
    // second time.
    const assessed = analysisContext(marketData, analysis.timestamp);

    return {
        analysis,
        fallbackSuppressed,
        // Built here rather than at the boundary because this is where the
        // context is: `analysisContext` costs two passes over the candles, and
        // calling it a second time to fill in an explanation would measure the
        // market twice for a field nobody has to wait longer than.
        explanation: buildExplanation(analysis, assessed),
        status: {
            stale: marketDataStale,
            ageMs: marketDataAgeMs,
            freshness: marketFreshness,
            provider: marketProvider,
        },
        market: {
            symbol: marketData.price.symbol,
            candles: marketData.candles,
            provider: marketData.provider,
        },
        context: assessed.context,
        resolved,
        telemetry(requestId) {
            return buildAnalysisTelemetry(
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
                    // The state, not just the boolean. "Stale" covers a
                    // snapshot behind the market and a snapshot that is
                    // current while the feed is dead, and those two call for
                    // different responses.
                    freshness: marketFreshness,
                    signalRule: publishedBy,
                    fallbackSuppressed,
                    ...(marketDataStale
                        ? { dataStale: true, dataAgeMs: marketDataAgeMs }
                        : {}),
                    ...(requestId !== undefined ? { requestId } : {}),
                },
            );
        },
        fallbackFailure() {
            return fallbackFailure;
        },
    };
}

/**
 * What the market looked like, in all three shapes something needs it.
 *
 * One assessment, three renderings. `context` is the flattened form the history
 * row has been storing since before anything could explain itself; `regime` and
 * `quality` are the assessments themselves, which the explanation reads.
 *
 * Both assessments are wrapped: a signal that was published is a signal the
 * system stands behind, and a regime or a quality score is context, not a gate.
 *
 * It is one function because it is one measurement. The explanation and the
 * history describing the same candles differently is exactly the failure this
 * shape exists to make impossible.
 */
interface MarketAssessment {
    readonly context: SignalContext | undefined;
    readonly regime: ReturnType<typeof assessRegime> | null;
    readonly quality: ReturnType<typeof assessDataQuality> | null;
}

/**
 * Losing the context on a series too short to assess it is correct; failing to
 * record a signal that was correctly produced is not. The whole thing is
 * therefore best-effort and returns empty rather than propagating.
 */
function analysisContext(
    marketData: MarketData,
    now: number,
): MarketAssessment {
    try {
        const quality = assessDataQuality({
            candles: marketData.candles,
            now,
            intervalMs: marketConfig.candleIntervalMs,
            provider: marketData.provider,
        });
        // The regime window is a length in time, so it needs to know how long a
        // bar is. The candles are fetched for this market's interval; without
        // saying so, the baseline would be 720 bars of whatever this is — 30
        // days hourly, 12 hours on a minute chart.
        const regime = assessRegime({
            candles: marketData.candles,
            interval: marketConfig.candleInterval,
        });

        return {
            context: {
                regime: regime.unreliable === null
                    ? `${regime.volatility}/${regime.trend}`
                    : `${regime.volatility}/${regime.trend} (${regime.unreliable})`,
                dataQuality: quality.score,
                dataQualityUsable: quality.usable,
                dataQualityWorst: quality.worst,
            },
            // The assessments themselves, not their flattened form.
            //
            // The history row wants one string and three loose numbers; the
            // explanation wants the regime on two axes plus a warning about
            // trusting it, and the quality as a scored object. My first version
            // kept only the flattened `SignalContext` and rebuilt the rest from
            // it — which meant two of `RegimeContext`'s three fields had no
            // honest value and I was one plausible-looking object away from
            // inventing a structure out of a label. Carrying the assessments
            // costs nothing: they were already computed.
            regime,
            quality,
        };
    } catch {
        return { context: undefined, regime: null, quality: null };
    }
}
