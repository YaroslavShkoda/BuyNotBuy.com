import { getSignalSnapshotRepository } from '../analysis/signal-snapshot.repository.js';
import { getStrategyVersionRepository } from '../analysis/strategy-version.repository.js';
import { marketConfig } from '../config/market.config.js';
import { recordSignalHistory } from '../history/signal-history.service.js';
import type { SignalContext, SignalHistoryLogger } from '../history/signal-history.types.js';
import { recordIndicatorVotes } from '../indicators/performance/indicator-performance.service.js';
import { currentRegistry } from '../observability/registry.js';
import { getDecisionLogRepository } from '../strategies/decision-log.repository.js';
import type { ResolvedSignal } from '../strategies/registry.js';
import type { MarketAnalysis } from '../types/analysis.js';
import type { Candle } from '../types/market.js';

/**
 * The writes the analysis path commits, and nothing else.
 *
 * Split out of `analysis.service.ts` so that the analysis and the persistence
 * stay two decisions: this module answers "what lands where", and the service
 * answers "when". Non-critical by contract — every write here is fire and
 * forget and swallows its own errors, because a persistence failure must
 * never fail the analysis response.
 */

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
export function writeHistory(
    input: {
        readonly analysis: MarketAnalysis;
        readonly symbol: string;
        readonly candles: Candle[];
        readonly provider: string;
        /**
         * The context, already measured by whoever built the explanation.
         *
         * Passed in rather than recomputed: this is two passes over the
         * candles, the explanation is built from the same measurement, and
         * measuring the market twice for one answer would be the kind of cost
         * that looks free until two people copy it.
         */
        readonly context?: SignalContext | undefined;
    },
    historyLogger: SignalHistoryLogger = SILENT_HISTORY_LOGGER,
): void {
    // The market these numbers were produced in. A performance table grouped
    // by regime is the whole reason this column exists, and without it every
    // signal looks like it came from the same market.
    void recordSignalHistory(
        {
            timestamp: input.analysis.timestamp,
            symbol: input.symbol,
            signal: input.analysis.signal.signal,
            consensus: input.analysis.signal.confidence,
            price: input.analysis.price,
            // Conditional rather than assigned undefined: an absent context is
            // a fact, and writing one is how a table ends up full of nulls that
            // look like a failed write.
            ...(input.context === undefined ? {} : { context: input.context }),
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
    void recordIndicatorVotes(input.analysis, input.symbol, historyLogger);

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
            symbol: input.symbol,
            price: input.analysis.price,
            candles: input.candles,
            provider: input.provider,
            snapshot: input.analysis,
        },
        historyLogger,
    ).catch(() => undefined);
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

export async function recordStrategyDecisions(input: {
    symbol: string;
    published: ResolvedSignal;
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
