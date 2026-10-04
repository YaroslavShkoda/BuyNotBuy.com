import type { SignalExplanation } from '../signals/explanation.js';
import type { MarketRequest } from '../market/capability.js';
import type { MarketAnalysis } from '../types/analysis.js';
import type { Candle, MarketData } from '../types/market.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import type { DivergenceAnalysis } from '../indicators/divergence.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import { recordPublishedSignal } from '../signals/signal-publication.js';
import { createKeyedSingleFlight } from '../observability/single-flight.js';
import { currentRegistry } from '../observability/registry.js';

import { getMarketData, marketKey, resolveRequest } from '../market/market.service.js';
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
import { explainSignal } from '../signals/explanation.js';
import { consensusConfig } from '../config/consensus.config.js';
import {
    indicatorConfig,
    signalConfigFor,
} from '../config/indicator.config.js';
import {
    attachAnalysisErrorContext,
    readAnalysisErrorContext,
    buildAnalysisTelemetry,
    measureAsync,
    measureSync,
} from './analysis.telemetry.js';

import type { AnalysisFailedStage, AnalysisTelemetry, AnalysisTelemetryLogger, FallbackFailureContext } from './analysis.telemetry.js';
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
    /**
     * Why the signal was published, in a form that can be argued with.
     *
     * Backend-only, and outside `MarketAnalysis` for the same reason
     * `fallbackSuppressed` is: `MarketAnalysis.signal` is a `SignalResult`,
     * and that type is part of the frozen contract.
     *
     * It earns its place by carrying the three things the published signal
     * does not say: which indicator voted which way, what the market looked
     * like while they did, and -- the part that matters most -- that the
     * published percentage is a panel consensus and **not** a probability of
     * being right. The `explanation.ts` module was written for exactly
     * this and sat unwired, so nothing in the system could produce it.
     */
    readonly explanation: SignalExplanation;
}


export async function analyzeMarket(
    logger?: AnalysisTelemetryLogger,
    requestId?: string,
    historyLogger?: SignalHistoryLogger,
    instrument?: string | undefined,
): Promise<MarketAnalysis> {
    const { analysis } = await analyzeMarketWithStatus(
        logger,
        requestId,
        historyLogger,
        instrument,
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
    /**
     * Which market to analyse, or the configured one.
     *
     * Optional rather than required so the frozen `/api/analysis` and the poller
     * keep working unchanged, and passed by the per-instrument route that names
     * one. The interval comes along with the request because it is part of what
     * makes two markets different markets: two intervals of one symbol are two
     * series, and `marketKey` says so.
     */
    instrument?: string | undefined,
): Promise<AnalysisWithStatus> {
    const request = resolveRequest({ instrument, interval: marketConfig.candleInterval });
    let result: AnalysisComputation;
    let leader: boolean;

    try {
        ({ result, leader } = await analysisFlights
            .forMarket(marketKey(request))
            .run(() => computeAnalysis(request)));
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

    // The run completed and part of it did not work. Logged here, per caller,
    // for the same reason the line above is: a reader tracing a request id has
    // to find a line of their own, and a coalesced run of ten requests is ten
    // things that were served by a fallback that is broken.
    const fallbackFailure = result.fallbackFailure();

    if (fallbackFailure !== null) {
        logger?.error(fallbackFailure, 'fallback_strategy_failed');
    }

    // Publication is per caller too: a signal handed to somebody is a signal
    // the system produced, and N callers received N answers.
    //
    // The market is passed because the previous signal is remembered **per
    // market**. With one variable for the process, BTCUSDT publishing LONG and
    // then ETHUSDT publishing SHORT counted as a change while neither market
    // changed — so the counter meant "how often two markets disagree" instead of
    // "how often this market revises itself".
    recordPublishedSignal(result.analysis.signal.signal, request.instrument);

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
        // Beside `MarketAnalysis`, never inside it -- `signal` is a
        // `SignalResult` and that type is part of the frozen contract. This is
        // the same place `provider` and `freshness` live: a backend-only field
        // a client may ignore and a reader on the backend can rely on.
        explanation: result.explanation,
    };
}

/**
 * One coalescer per market, not one for the process.
 *
 * `createKeyedSingleFlight` already existed and is used by `getPrice` — the
 * market layer learned this lesson first. The analysis path had the unkeyed one
 * and was correct only because `computeAnalysis` took no market at all: two
 * analyses for two markets would have joined one flight, and the second caller
 * would have been handed the first market's analysis with a plausible price and
 * a correct shape. `research/market-axis.test.ts` is what pointed at the line.
 */
const analysisFlights = createKeyedSingleFlight<AnalysisComputation>();

/**
 * Markets with a coalescer, for the test that asserts there is one per market.
 *
 * A read-only view rather than the object itself: what is worth checking is that
 * two markets end up on two coalescers, and handing out the map would let a test
 * depend on the thing it is auditing.
 */
export function analysisFlightKeys(): readonly string[] {
    return analysisFlights.keys;
}

/**
 * Persists what both strategies said, and never fails the analysis over it.
 *
 * Fire and forget, like the three history writes this file already does, and
 * for the same reason: the analysis is correct the moment the signal exists,
 * and a database that is briefly unavailable should not turn a trading
 * decision into a 500.
 *
 * **The failure is counted, not swallowed.** The first version of this caught
 * and discarded, on the grounds that the caller is a hot path and has already
 * published a correct answer. Both halves are true, and together they hid a
 * month of nothing: a leftover process from an earlier verification was holding
 * the port, so the server under test never started, and the journal stayed
 * empty. That looked exactly like a code fault and was investigated as one.
 *
 * A count is enough. A dropped row is still a dropped row — the table is the
 * evidence base and not a cache — but a count rising to something other than
 * zero is a fact that can be looked at, and a silent failure is indistinguishable
 * from a system that is working.
 */
let strategyDecisionWriteFailures = 0;

/** How many decision-log rows were lost. Read by tests and by a human. */
export function strategyDecisionWriteFailureCount(): number {
    return strategyDecisionWriteFailures;
}

/** Test seam: the counter is a module-level number, and tests share the module. */
export function resetStrategyDecisionWriteFailures(): void {
    strategyDecisionWriteFailures = 0;
}

async function recordStrategyDecisions(input: {
    symbol: string;
    published: ReturnType<typeof resolveSignal>;
}): Promise<void> {
    try {
        const strategyVersion = await getStrategyVersionRepository().resolveActive(
            input.symbol,
        );
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
            fallback:
                fallback === null || published.fallbackKey === null
                    ? null
                    : {
                          rule: published.fallbackKey,
                          direction: fallback.direction,
                          confidence: fallback.confidence,
                      },
            publishedRule: published.publishedBy,
            publishedDirection: published.published.direction,
            suppressed: published.suppressed,
        });
    } catch {
        // Still not thrown: an analysis that has a correct signal must not be
        // turned into a 500 by a bookkeeping write. But the count moves, and
        // that is the difference between this and the version that hid a dead
        // server behind a plausible-looking empty table.
        strategyDecisionWriteFailures += 1;

        // The module counter above is read by nobody outside this file, so a
        // lost row was counted and invisible — a silent failure wearing the
        // costume of an observed one. This is the count an operator can see,
        // and it is the same event, not a second reading of it.
        //
        // **Labelled by market, and this is not the same choice as the two signal
        // counters next door.** Those stay unlabelled on purpose: their consumers
        // (`churnRate()` and the calibration code) read a process-wide rate, and
        // a reader who wants one market's churn filters in the structured log
        // instead. This counter reports *lost rows*, which is a different kind of
        // fact: a loss is not a rate, it is a hole in a specific series, and a
        // total cannot say which series lost one. With two markets running, "we
        // lost decision rows" and "we lost decision rows for the market whose
        // accuracy we are about to trust" are different sentences, and the market
        // was in scope the whole time — it is `input.symbol`.
        currentRegistry().counter(
            'strategy_decision_write_failures',
            1,
            { market: input.symbol },
        );
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
    // `explanation` is excluded on purpose: it is a property of the computation,
    // not of the market's freshness, and letting `Omit` pick it up would file a
    // claim about the signal inside an object called `status`.
    readonly status: Omit<AnalysisWithStatus, 'analysis' | 'explanation'>;
    /**
     * True when the fallback would have changed the published signal and was
     * held back by shadow mode.
     *
     * Backend-only, and deliberately outside `MarketAnalysis`: the dashboard
     * contract is frozen, and this is a number about the system's own
     * confidence in its configuration rather than about the market. It is the
     * evidence the shadow period exists to collect.
     */
    readonly     fallbackSuppressed: boolean;
    /** Built once per computation, beside the analysis it explains. */
    readonly explanation: SignalExplanation;
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
    /** Writes the history rows for this computation, once. */
    record(historyLogger?: SignalHistoryLogger): void;
}

async function computeAnalysis(request: MarketRequest): Promise<AnalysisComputation> {
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
    // rather than the system. The tick happens per caller, above.

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
        explanation: explainSignal({
            direction: analysis.signal.signal,
            confidence: analysis.signal.confidence,
            confidenceModel: consensusConfig.confidenceModel,
            analyses: analysis.signal.indicators,
            // The published sentence, handed in rather than rebuilt. Explaining a
            // signal with a reason other than the one that was published is how a
            // system ends up defending two things at once, and the reason this
            // module sat unwired for its whole life is that nothing could check
            // that the two agreed.
            reason: analysis.signal.reason,
            // The assessment carries the factor with its score and a
            // sentence; the explanation wants the name on it. Reduced here,
            // deliberately, and the name still comes from the factor itself
            // rather than from a description of it -- which is how a summary
            // drifts away from the thing it summarises.
            quality:
                assessed.quality === null
                    ? null
                    : {
                          score: assessed.quality.score,
                          usable: assessed.quality.usable,
                          // `QualityFactor` is the name, not a record: the score
                          // and the sentence live in `factors`, and a summary
                          // that renamed them would describe something else.
                          worst: assessed.quality.worst,
                          blockedBy:
                              assessed.quality.blockedBy === null
                                  ? []
                                  : [assessed.quality.blockedBy],
                      },
            regime: assessed.regime,
        }),
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
        fallbackFailure() {
            return fallbackFailure;
        },
        record(historyLogger) {
            writeHistory(analysis, marketData, historyLogger, assessed.context);
        },
    };
}

/**
 * The one logger that says nothing, named so that saying nothing is a choice.
 *
 * `writeHistory` is reached from paths that have a logger and from ones that do
 * not, and the ones that do not are tests and embeddings. Rather than let the
 * optional parameter apply itself quietly at the bottom of the chain — which is
 * what made the vote write silent for as long as it was — the silence is written
 * down here, in one place, and everything below it can take a logger as given.
 */
const SILENT_HISTORY_LOGGER: SignalHistoryLogger = {
    warn: () => undefined,
};

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
    historyLogger: SignalHistoryLogger = SILENT_HISTORY_LOGGER,
    /**
     * The context, already measured by whoever built the explanation.
     *
     * Passed in rather than recomputed: this is two passes over the candles, and
     * the explanation above needs the same answer, and measuring the market
     * twice for one answer would be the kind of cost that looks free until two
     * people copy it.
     */
    context?: SignalContext,
): void {
    // The market these numbers were produced in. A performance table grouped
    // by regime is the whole reason this column exists, and without it every
    // signal looks like it came from the same market.
    const resolved = context ?? analysisContext(marketData, analysis.timestamp).context;

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
            ...(resolved === undefined ? {} : { context: resolved }),
        },
        historyLogger,
    );
    // The consensus is one number that hides its inputs, so each indicator's
    // own vote is stored next to it. This is what later answers "was the EMA
    // actually right?" instead of leaving it a matter of faith. Also
    // fail-open, and it does not belong in the response either way.
    //
    // **The logger is passed, and it used not to be.** `recordIndicatorVotes`
    // reported a refused write through `logger?.warn`, and with no argument that
    // was a no-op: the votes went into the backlog and the failure was
    // completely silent, in the module that exists so the question "is the EMA
    // any good" has an answer. The sweep of omitted optional parameters is what
    // named it — `recordIndicatorVotes()` called with 2 of 3 arguments — and it
    // is the only production call site, so there was nothing else to check.
    void recordIndicatorVotes(analysis, marketData.price.symbol, historyLogger);

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
    // Fire and forget on purpose: every other write on this path is too, and
    // making this one awaited would put a database round trip in the critical
    // path of every page load for the sake of an identifier. The poller, which
    // runs on a schedule and is not answering anybody, stores the same
    // snapshot itself and gets the id back; the hash makes whichever lands
    // second a deduplicated no-op rather than a second row.
    void storeSnapshot(
        {
            symbol: marketData.price.symbol,
            price: analysis.price,
            candles: marketData.candles,
            provider: marketData.provider,
            snapshot: analysis,
        },
        historyLogger,
    ).catch(() => undefined);
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

/**
 * Writes one immutable snapshot and says which row it landed on.
 *
 * Takes the four things it actually uses rather than the whole `MarketData`,
 * because the poller has exactly these four and no `MarketData` object: a
 * caller that has to fabricate a market to store a snapshot will fabricate
 * something wrong, and nothing about the row would say so.
 *
 * Returns the row id, or null when the write failed or was refused. A caller
 * that needs the id **must** treat null as a real answer rather than as a
 * missing one: a snapshot the system cannot point at is a signal that cannot be
 * traced to the rule that produced it, and the difference is invisible in the
 * row it would have been.
 */
export async function storeSnapshot(
    input: {
        readonly symbol: string;
        readonly price: number;
        readonly candles: Candle[];
        readonly provider: string;
        readonly snapshot: MarketAnalysis;
    },
    logger?: SignalHistoryLogger,
): Promise<number | null> {
    try {
        const strategyVersion = await getStrategyVersionRepository().resolveActive(
            input.symbol,
        );

        const stored = await getSignalSnapshotRepository().record({
            symbol: input.symbol,
            strategyVersion,
            price: input.price,
            candles: input.candles,
            // Both are part of what the snapshot *is*, not of what it contains.
            // Two venues can serve identical bars; without these the second
            // snapshot is silently discarded as a duplicate of the first, and
            // the row that survives is attributed to whichever arrived first.
            provider: input.provider,
            interval: marketConfig.candleInterval,
            snapshot: input.snapshot,
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

        return stored.id;
    } catch (error) {
        logger?.warn(
            { event: 'signal_snapshot_store_failed', err: error },
            'signal_snapshot_store_failed',
        );

        return null;
    }
}
