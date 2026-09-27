import type { MarketAnalysis } from '../types/analysis.js';
import type { MarketData } from '../types/market.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import type { DivergenceAnalysis } from '../indicators/divergence.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import { recordPublishedSignal } from '../signals/signal-publication.js';
import { createSingleFlight } from '../observability/single-flight.js';

import { getMarketData } from '../market/market.service.js';
import { calculateMarketIndicators, toWireIndicators } from '../indicators/indicator.service.js';
import { calculateSignal } from '../signals/signal.service.js';
import { calculateMomentumSeries } from '../indicators/momentum-series.js';
import { analyzeDivergence } from '../indicators/divergence.service.js';
import { recordSignalHistory } from '../history/signal-history.service.js';
import { recordIndicatorVotes } from '../indicators/performance/indicator-performance.service.js';
import { getSignalSnapshotRepository } from '../analysis/signal-snapshot.repository.js';
import { getStrategyVersionRepository } from '../analysis/strategy-version.repository.js';
import { createRegistry, readFallbackConfig, resolveSignal } from '../strategies/registry.js';
import { getDecisionLogRepository } from '../strategies/decision-log.repository.js';
import { marketConfig } from '../config/market.config.js';
import { assessDataQuality } from '../history/data-quality.js';
import { assessRegime } from '../indicators/regime.js';
import {
    indicatorConfig,
    INDICATOR_SIGNAL_CONFIG,
} from '../config/indicator.config.js';
import {
    attachAnalysisErrorContext,
    readAnalysisErrorContext,
    buildAnalysisTelemetry,
    measureAsync,
    measureSync,
} from './analysis.telemetry.js';

import type { AnalysisFailedStage, AnalysisTelemetry, AnalysisTelemetryLogger } from './analysis.telemetry.js';
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
 *
 * Concurrent callers are still collapsed into one computation, and that is a
 * correctness measure rather than a performance one. Every successful analysis
 * writes a history row, so N page loads arriving together would record the
 * same decision N times for the same hour — and a history that says the market
 * held still N times teaches the calibration code something false about how
 * often this system changes its mind.
 *
 * The consequence is worth stating because it cuts both ways. The expensive
 * part — the fetch and the seven indicators — is computed once. The telemetry
 * line is still written once per caller, each carrying its own request id,
 * because ten requests are ten requests and a reader tracing one of them has to
 * find a line of its own. The history row is written once per computation,
 * because that is the one write that must not repeat.
 */
export async function analyzeMarketWithStatus(
    logger?: AnalysisTelemetryLogger,
    requestId?: string,
    historyLogger?: SignalHistoryLogger,
): Promise<AnalysisWithStatus> {
    let result: AnalysisComputation;
    let leader: boolean;

    try {
        ({ result, leader } = await analysisFlight.run(() => computeAnalysis()));
    } catch (error) {
        // The request id is stamped here, per caller, rather than inside the
        // computation. It is safe to mutate the error because a caller that
        // failed owns it: a follower that was handed somebody else's failure
        // has already thrown that one away and run its own attempt.
        const shared = readAnalysisErrorContext(error);

        if (shared !== undefined) {
            attachAnalysisErrorContext(error, {
                ...shared,
                ...(requestId !== undefined ? { requestId } : {}),
            });
        }

        throw error;
    }

    // Telemetry is per caller, not per computation. Ten requests coalesced into
    // one analysis are still ten requests, and a reader tracing a request id
    // has to find a line of its own. The work those lines describe was shared;
    // the fact that ten callers asked for it is what each line is for.
    const telemetry = result.telemetry(requestId);

    logger?.info(telemetry, 'market_analysis_completed');

    // Publication is per caller too: a signal handed to somebody is a signal
    // the system produced, and N callers received N answers.
    recordPublishedSignal(result.analysis.signal.signal);

    // The history is per computation. This is the write that must not repeat:
    // N rows for one hour would tell the calibration code that the market held
    // still N times, and that number is then measured against outcomes as if
    // it were true.
    if (leader) {
        result.record(historyLogger);
    }

    return {
        analysis: result.analysis,
        stale: result.status.stale,
        ageMs: result.status.ageMs,
        freshness: result.status.freshness,
        provider: result.status.provider,
    };
}

const analysisFlight = createSingleFlight<AnalysisComputation>();

/**
 * Persists what both strategies said, and never fails the analysis over it.
 *
 * Fire and forget, like the three history writes this file already does, and
 * for the same reason: the analysis is correct the moment the signal exists,
 * and a database that is briefly unavailable should not turn a trading
 * decision into a 500. The cost of that choice is that a lost row is a lost
 * row — which is why the table is the evidence base and not a cache, and why
 * the report below is read as "what the shadow period saw", not as a
 * guaranteed-complete ledger.
 */
async function recordStrategyDecisions(input: {
    symbol: string;
    published: ReturnType<typeof resolveSignal>;
}): Promise<void> {
    try {
        const strategyVersion = await getStrategyVersionRepository().resolveActive();
        const { published } = input;
        const fallback = published.fallbackDecision;

        await getDecisionLogRepository().record({
            symbol: input.symbol,
            strategyVersionId: strategyVersion.id,
            at: Date.now(),
            primary: {
                rule: 'consensus-primary',
                // The primary's own answer, not the published one. When the
                // fallback is active and the primary had an opinion, those are
                // different, and storing the published direction here would
                // record an agreement that never happened.
                direction: published.primaryDecision.direction,
                confidence: published.primaryDecision.confidence,
            },
            fallback: fallback === null
                ? null
                : {
                      rule: published.publishedBy,
                      direction: fallback.direction,
                      confidence: fallback.confidence,
                  },
            publishedRule: published.publishedBy,
            publishedDirection: published.published.direction,
            suppressed: published.suppressed,
        });
    } catch {
        // See the note above. Deliberately silent: the caller is a hot path and
        // has already published a correct answer.
    }
}

/**
 * What one analysis costs and what it produced.
 *
 * The telemetry builders and the history writes travel with the result rather
 * than being called from inside the computation, because those are per-caller
 * and the computation is shared. Bundling them here keeps the split in one
 * place instead of in the reader's head.
 */
interface AnalysisComputation {
    readonly analysis: MarketAnalysis;
    readonly status: Omit<AnalysisWithStatus, 'analysis'>;
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
    /** One context per caller, differing only in the request id. */
    telemetry(requestId?: string): AnalysisTelemetry;
    /** Writes the history rows for this computation, once. */
    record(historyLogger?: SignalHistoryLogger): void;
}

async function computeAnalysis(): Promise<AnalysisComputation> {
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
    let fallbackSuppressed = false;
    let publishedBy: string = 'consensus-primary';
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
                const consensus = calculateSignal(price, indicators, emaCloses);

                return {
                    direction: consensus.signal,
                    confidence: consensus.confidence,
                    reason: consensus.reason,
                    warm: false,
                };
            },
            emaConfirmBars: INDICATOR_SIGNAL_CONFIG.ema.confirmBars,
        });

        const resolved = resolveSignal(registry, {
            candles: marketData.candles,
            price: marketData.price.price,
        });

        fallbackSuppressed = resolved.suppressed;
        publishedBy = resolved.publishedBy;

        // Written down before anything else uses the answer, and best effort.
        // A shadow period that does not leave a record is not a shadow period,
        // it is a guess — and the decision to promote a rule rests on what this
        // table eventually holds.
        //
        // Both answers go in, not just the published one: the disagreements are
        // the only rows worth having, and they are exactly the ones a published
        // answer cannot reconstruct.
        void recordStrategyDecisions({
            symbol: marketData.price.symbol,
            published: resolved,
        });

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
        if (readFallbackConfig().mode === 'active') {
            fail(error, 'signal');
        }
    }

    const marketDataDurationMs = completedDurations.marketDataDurationMs ?? 0;    const indicatorsDurationMs = completedDurations.indicatorsDurationMs ?? 0;
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
    // rather than the system. The tick happens per caller, above.

    return {
        analysis,
        fallbackSuppressed,
        status: {
            stale: marketDataStale,
            ageMs: marketDataAgeMs,
            freshness: marketFreshness,
            provider: marketProvider,
        },
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
        record(historyLogger) {
            writeHistory(analysis, marketData, historyLogger);
        },
    };
}

/**
 * The writes that must happen once per computation, not once per caller.
 *
 * Non-critical by contract: a persistence failure must never fail the analysis
 * response. Deliberately not awaited — against a file that cost was invisible;
 * against a database on the network it is a round trip, and awaiting it would
 * turn "fail open" into "fail slow", so a database that is down would add its
 * connect timeout to every page load instead of only to the history. The three
 * calls swallow their own errors, so the discarded promises cannot reject into
 * an unhandled rejection.
 */
function writeHistory(
    analysis: MarketAnalysis,
    marketData: MarketData,
    historyLogger?: SignalHistoryLogger,
): void {
    // The market these numbers were produced in. A performance table grouped
    // by regime is the whole reason this column exists, and without it every
    // signal looks like it came from the same market.
    const context = analysisContext(marketData, analysis.timestamp);

    void recordSignalHistory(
        {
            timestamp: analysis.timestamp,
            symbol: marketData.price.symbol,
            signal: analysis.signal.signal,
            consensus: analysis.signal.confidence,
            price: analysis.price,
            // Conditional rather than assigned undefined: an absent context is
            // a fact, and writing one is how a table ends up full of nulls that
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
    // Idempotent on the input hash, so a retry cannot produce a second copy.
    void storeSnapshot(analysis, marketData, historyLogger).catch(() => undefined);
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
