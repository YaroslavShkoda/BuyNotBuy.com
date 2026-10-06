import { marketConfig } from '../config/market.config.js';
import type { SignalHistoryLogger } from '../history/signal-history.types.js';
import { marketKey, resolveRequest } from '../market/market.service.js';
import { createKeyedSingleFlight } from '../observability/single-flight.js';
import type { SignalExplanation } from '../signals/explanation.js';
import { recordPublishedSignal } from '../signals/signal-publication.js';
import type { MarketAnalysis } from '../types/analysis.js';
import type { AnalysisComputation, MarketAnalysisStatus } from './analysis.engine.js';
import { computeAnalysis } from './analysis.engine.js';
import {
    recordStrategyDecisions,
    writeHistory,
} from './analysis.persistence.js';
import type { AnalysisTelemetryLogger } from './analysis.telemetry.js';
import { attachAnalysisErrorContext, readAnalysisErrorContext } from './analysis.telemetry.js';

export {
    resetStrategyDecisionWriteFailures,
    storeSnapshot,
    strategyDecisionWriteFailureCount,
} from './analysis.persistence.js';

/**
 * The analysis contract, and the workflow around the computation.
 *
 * `analysis.engine.ts` computes; `analysis.persistence.ts` writes. This file is
 * what a caller sees: the two entry points, the per-market coalescer, and the
 * aftermath split the way it has to be — telemetry and publication per caller,
 * the history rows and the decision journal once per computation.
 */
export interface AnalysisWithStatus extends MarketAnalysisStatus {
    analysis: MarketAnalysis;
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
        writeHistory(
            {
                analysis: result.analysis,
                symbol: result.market.symbol,
                candles: result.market.candles,
                provider: result.market.provider,
                context: result.context,
            },
            historyLogger,
        );

        // The decision journal travels under the same leader gate as the
        // history: once per computation, never once per caller. Written down
        // before anything else uses the answer, and best effort. A shadow
        // period that does not leave a record is not a shadow period, it is a
        // guess — and the decision to promote a rule rests on what this table
        // eventually holds.
        //
        // Both answers go in, not just the published one: the disagreements are
        // the only rows worth having, and they are exactly the ones a published
        // answer cannot reconstruct.
        //
        // `resolved` is null only when the fallback failed in a mode where its
        // failure was not the run's failure. Then there is no journal row —
        // which is one more thing the fallback-failure line above is for.
        if (result.resolved !== null) {
            void recordStrategyDecisions({
                symbol: result.market.symbol,
                published: result.resolved,
            });
        }
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
