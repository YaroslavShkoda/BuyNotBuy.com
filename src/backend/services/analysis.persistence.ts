import { getSignalSnapshotRepository } from '../analysis/signal-snapshot.repository.js';
import { getStrategyVersionRepository } from '../analysis/strategy-version.repository.js';
import { historyConfig } from '../config/history.config.js';
import { marketConfig } from '../config/market.config.js';
import { writeSpoolConfig } from '../config/write-spool.config.js';
import { recordSignalHistory } from '../history/signal-history.service.js';
import type { SignalContext, SignalHistoryLogger } from '../history/signal-history.types.js';
import { recordIndicatorVotes } from '../indicators/performance/indicator-performance.service.js';
import type {
    BacklogState,
    BacklogStateByMarket,
} from '../observability/bounded-write-buffer.js';
import {
    createBoundedWriteBuffer,
    createFlushGuard,
    mergeBacklogStates,
} from '../observability/bounded-write-buffer.js';
import { currentRegistry } from '../observability/registry.js';
import { createWriteSpool } from '../observability/write-spool.js';
import type {
    DecisionEntry,
    DecisionLogRepository,
} from '../strategies/decision-log.repository.js';
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
 * **The failure is counted, and the row is now kept.** The first version of
 * this caught and discarded, on the grounds that the caller is a hot path and
 * has already published a correct answer. Both halves are true, and together
 * they hid a month of nothing: a leftover process from an earlier verification
 * was holding the port, so the server under test never started, and the journal
 * stayed empty. That looked exactly like a code fault and was investigated as
 * one.
 *
 * A count is the "is the database accepting writes" signal, and the buffer is
 * the reason a rising count no longer means a hole: history and the votes have
 * carried backlogs for exactly this, while the journal the promotion decision
 * is made from was the one still dropping — and the shadow report then read its
 * surviving rows as if they were the whole sample.
 */
let strategyDecisionWriteFailures = 0;

/** How many decision-log writes the database refused. Read by tests and by a human. */
export function strategyDecisionWriteFailureCount(): number {
    return strategyDecisionWriteFailures;
}

/** Test seam: the counter is a module-level number, and tests share the module. */
export function resetStrategyDecisionWriteFailures(): void {
    strategyDecisionWriteFailures = 0;
}

/**
 * Decision rows that could not be written, held for a retry.
 *
 * The journal is the evidence base the promotion decision is made from, and a
 * row lost to a dead connection is not a neutral gap: the shadow report reads
 * the surviving rows as the whole sample, so the agreement rate it reports is
 * computed from whichever cycles happened to land while the database was
 * healthy. History and the votes have carried buffers for exactly this reason;
 * this was the third and last write still dropping.
 */
const decisionBacklog = createBoundedWriteBuffer<DecisionEntry>({
    maxSize: historyConfig.maxBufferedEntries,
    label: 'strategy_decision',
    marketOf: (entry) => entry.symbol,
});

/**
 * At most one flush at a time. The backlog is drained into a local array, so
 * two concurrent flushes would both be writing while a push lands in the array
 * one of them is about to re-queue.
 */
const runDecisionFlush = createFlushGuard();

/**
 * Consecutive failed attempts per buffered row. A `WeakMap` keyed by the entry
 * itself, because rows are re-queued **by identity** — the same object comes
 * back out of `drain()` — and Weak so a given-up row leaves nothing behind.
 */
const decisionAttempts = new WeakMap<DecisionEntry, number>();

/**
 * The same ceiling the history and vote buffers use, and the same reason: a row
 * retried for ever becomes the newest entry in a buffer that drops its oldest,
 * so the retry protects the thing that is broken at the expense of the thing
 * that is not.
 */
const MAX_DECISION_ATTEMPTS = 5;

/**
 * The same count for spooled rows, fresh at zero for rows read back off the
 * disk — a restart is a fresh process making a fresh attempt at rows it has
 * just been handed back.
 */
const spoolDecisionAttempts = new WeakMap<DecisionEntry, number>();

/**
 * The durable overflow lane for decision rows.
 *
 * The memory bound above covers roughly the last half hour of cycles. The
 * decision journal is what a promotion has to be audited against — the record
 * of what was published, by which configuration, and what was suppressed — so
 * "the database was down for an afternoon" must not read, six months later,
 * as "no decisions were made that afternoon". A spooled row survives the
 * restart that would have taken the memory queue with it.
 */
const decisionSpool = createWriteSpool<DecisionEntry>({
    name: 'strategy_decision',
    directory: writeSpoolConfig.directory,
    maxBytes: writeSpoolConfig.maxBytesPerWriter,
    enabled: writeSpoolConfig.enabled,
    marketOf: (entry) => entry.symbol,
});

/**
 * The version the market's running configuration belongs to, or null when the
 * database would not say.
 *
 * Null is the honest answer rather than a retry: the row this feeds is frozen
 * at decision time, and resolving again later would read whichever
 * configuration is current by then — provenance the decision was never made
 * under.
 */
async function resolveStrategyVersionId(symbol: string): Promise<number | null> {
    try {
        return (await getStrategyVersionRepository().resolveActive(symbol)).id;
    } catch {
        return null;
    }
}

export async function recordStrategyDecisions(
    input: {
        symbol: string;
        published: ResolvedSignal;
    },
    logger?: SignalHistoryLogger,
): Promise<void> {
    const { published } = input;
    const fallback = published.fallbackDecision;

    // The row is assembled whole, before the write, because what the backlog
    // holds has to be the decision as it was made — not a recipe for rebuilding
    // it later. The assembly sits inside the same guard as the write on
    // purpose: nothing in a fire-and-forget path may throw, so a caller that
    // hands over a malformed answer costs a counted failure, not a failed
    // analysis, and there is simply no row to hold in that case.
    let entry: DecisionEntry | null = null;

    try {
        entry = {
            symbol: input.symbol,
            // The version is resolved before the row is built, and its failure
            // does not cost the cycle: the row keeps its content with a null
            // version, which is the state the column and the evidence gate
            // already hold — "decided, but not proven under a configuration".
            // Fabricating an id is the alternative, and re-resolving at flush
            // time would do exactly that by accident: `resolveActive` reads
            // the *current* configuration, so a configuration changed
            // mid-outage would hand the retry a version the decision was never
            // made under.
            strategyVersionId: await resolveStrategyVersionId(input.symbol),
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
        };

        await getDecisionLogRepository().record(entry);
    } catch (error) {
        if (entry !== null) {
            // The durable lane first, the memory buffer only if the disk
            // refuses too — never both, or the flush would replay the row from
            // one queue after the other had already written it. The insert is
            // idempotent under (symbol, created_at), so the spool's replay
            // after a crash lands as a no-op, not a second cycle.
            if (!decisionSpool.append(entry)) {
                decisionBacklog.push(entry);
            }
        }

        // Still not thrown: an analysis that has a correct signal must not be
        // turned into a 500 by a bookkeeping write. But the count moves, and
        // the row now waits in the backlog instead of going overboard — the
        // count is "the database refused a write", no longer "the row is gone".
        strategyDecisionWriteFailures += 1;

        // The module counter above is read by nobody outside this file, so a
        // failed write was counted and invisible — a silent failure wearing the
        // costume of an observed one. This is the count an operator can see,
        // and it is the same event, not a second reading of it.
        //
        // **Labelled by market, and this is not the same choice as the two signal
        // counters next door.** Those stay unlabelled on purpose: their consumers
        // (`churnRate()` and the calibration code) read a process-wide rate, and
        // a reader who wants one market's churn filters in the structured log
        // instead. This counter reports *refused writes*, which is a different
        // kind of fact: a failure is not a rate, it is a fact about a specific
        // series, and a total cannot say which series it happened to. With two
        // markets running, "the database refuses decision writes" and "the
        // database refuses decision writes for the market whose accuracy we are
        // about to trust" are different sentences, and the market was in scope
        // the whole time — it is `input.symbol`.
        currentRegistry().counter(
            'strategy_decision_write_failures',
            1,
            { market: input.symbol },
        );

        logger?.warn(
            {
                event: 'strategy_decision_record_failed',
                market: input.symbol,
                buffered: decisionBacklog.size,
                spooled: decisionSpool.size,
                dropped: decisionBacklog.droppedCount,
                err: error,
            },
            'strategy_decision_record_failed',
        );

        // Without this, a deployment with the poller off would fill the backlog
        // and silently overwrite its oldest rows — the same self-drain the
        // history and vote buffers run.
        if (decisionBacklog.size >= historyConfig.maxBufferedEntries) {
            await flushStrategyDecisionBacklog(logger);
        }
    }
}

async function writeDecisionBacklog(
    logger?: SignalHistoryLogger,
    repository: DecisionLogRepository = getDecisionLogRepository(),
): Promise<number> {
    // The file first: a spooled row has already waited through at least one
    // failure, and the memory queue must not cut in front of it.
    const written = await drainDecisionSpool(logger, repository);

    return written + (await drainDecisionMemory(logger, repository));
}

/**
 * Drains the spooled decision rows before the memory buffer's.
 *
 * The memory drain's shape — every row attempted, two consecutive failures
 * stop the flush, a lone failure retried a bounded number of times — with the
 * spool's two consequences: a refused-but-not-given-up row is rotated to the
 * back so it cannot stall the markets behind it, and the file is rewritten
 * once at the end of the drain, so a crash mid-drain only replays rows the
 * (symbol, created_at) insert has already folded away.
 */
async function drainDecisionSpool(
    logger?: SignalHistoryLogger,
    repository: DecisionLogRepository = getDecisionLogRepository(),
): Promise<number> {
    let written = 0;
    let givenUp = 0;
    let consecutiveFailures = 0;

    while (decisionSpool.size > 0) {
        const entry = decisionSpool.peek();

        if (entry === undefined) {
            break;
        }

        try {
            await repository.record(entry);

            written += 1;
            consecutiveFailures = 0;
            spoolDecisionAttempts.delete(entry);
            decisionSpool.confirm();
        } catch (error) {
            consecutiveFailures += 1;

            if (consecutiveFailures >= 2) {
                logger?.warn(
                    {
                        event: 'strategy_decision_spool_flush_failed',
                        written,
                        spooled: decisionSpool.size,
                        buffered: decisionBacklog.size,
                        err: error,
                    },
                    'strategy_decision_spool_flush_failed',
                );

                break;
            }

            const tries = (spoolDecisionAttempts.get(entry) ?? 0) + 1;

            if (tries >= MAX_DECISION_ATTEMPTS) {
                spoolDecisionAttempts.delete(entry);
                decisionSpool.drop();
                givenUp += 1;

                logger?.warn(
                    {
                        event: 'strategy_decision_spool_entry_given_up',
                        attempts: tries,
                        symbol: entry.symbol,
                        at: entry.at,
                        spooled: decisionSpool.size,
                        err: error,
                    },
                    'strategy_decision_spool_entry_given_up',
                );

                continue;
            }

            spoolDecisionAttempts.set(entry, tries);
            decisionSpool.rotate();
        }
    }

    decisionSpool.compact();

    if (givenUp > 0) {
        logger?.warn(
            { event: 'strategy_decision_spool_entries_given_up', givenUp },
            'strategy_decision_spool_entries_given_up',
        );
    }

    return written;
}

async function drainDecisionMemory(
    logger?: SignalHistoryLogger,
    repository: DecisionLogRepository = getDecisionLogRepository(),
): Promise<number> {
    if (decisionBacklog.size === 0) {
        return 0;
    }

    // Drained once, then handed back wholesale on failure. Peeking instead
    // would mean a `shift` that throws has already lost the row.
    const pending = decisionBacklog.drain();

    let written = 0;
    let failed = 0;
    let givenUp = 0;
    let consecutiveFailures = 0;

    // Every pending row is attempted, and only the ones that failed go back —
    // the same shape as the history and vote drains, for the same reason: one
    // refused row blocked every market behind it on every flush, for ever.
    //
    // Safe to continue, and safe to replay at all, because the insert is
    // idempotent under (symbol, created_at): a row that landed between the
    // failure and this retry turns the replay into a no-op rather than a
    // second copy. That is what the unique index is for — without it, a
    // buffered write would be a write that may not be attempted twice, and
    // the retry could inflate the evidence with a cycle already counted.
    for (const [index, entry] of pending.entries()) {
        try {
            await repository.record(entry);

            written += 1;
            consecutiveFailures = 0;
            decisionAttempts.delete(entry);
        } catch (error) {
            failed += 1;
            consecutiveFailures += 1;

            // Two in a row: the database is down, and the tail is handed back
            // untouched rather than repeating the same refusal for every row in
            // the buffer once a cycle. One, followed by a success: **this row**
            // is what the database will not take.
            if (consecutiveFailures >= 2) {
                for (const unprocessed of pending.slice(index)) {
                    decisionBacklog.push(unprocessed);
                }

                logger?.warn(
                    {
                        event: 'strategy_decision_flush_failed',
                        // Nothing was written, so the database is the story and
                        // the rest of the queue is untouched — `written: 0` is
                        // what makes that distinction readable in the log.
                        written,
                        failed,
                        buffered: decisionBacklog.size,
                        err: error,
                    },
                    'strategy_decision_flush_failed',
                );

                break;
            }

            // And a bounded number of retries. Re-queued, a row becomes the
            // newest in a buffer that evicts its oldest, so a row that can
            // never be written would sit there protecting itself while the
            // cycles the promotion decision rests on were dropped.
            const tries = (decisionAttempts.get(entry) ?? 0) + 1;

            if (tries >= MAX_DECISION_ATTEMPTS) {
                decisionAttempts.delete(entry);
                givenUp += 1;

                logger?.warn(
                    {
                        event: 'strategy_decision_entry_given_up',
                        attempts: tries,
                        symbol: entry.symbol,
                        at: entry.at,
                        buffered: decisionBacklog.size,
                        err: error,
                    },
                    'strategy_decision_entry_given_up',
                );

                continue;
            }

            decisionAttempts.set(entry, tries);
            decisionBacklog.push(entry);
        }
    }

    if (givenUp > 0) {
        logger?.warn(
            { event: 'strategy_decision_entries_given_up', givenUp },
            'strategy_decision_entries_given_up',
        );
    }

    return written;
}

/**
 * Retries every decision row that failed to write earlier.
 *
 * Rows are removed from the buffer as they are handed to the repository, so a
 * failure part-way through leaves the remaining ones queued for the next
 * attempt. Runs at most once at a time; a concurrent caller joins the run in
 * progress rather than starting a second one over the same array.
 */
export function flushStrategyDecisionBacklog(
    logger?: SignalHistoryLogger,
    repository?: DecisionLogRepository,
): Promise<number> {
    return runDecisionFlush(() => writeDecisionBacklog(logger, repository));
}

export function strategyDecisionBacklog(): BacklogState & {
    byMarket: BacklogStateByMarket;
} {
    return {
        buffered: decisionBacklog.size,
        // The spool's own losses fold into the same total — see the history
        // backlog for the full reasoning.
        dropped: decisionBacklog.droppedCount + decisionSpool.evictedCount + decisionSpool.tornCount,
        spooled: decisionSpool.size,
        byMarket: mergeBacklogStates(decisionBacklog.byMarket, decisionSpool.byMarket),
    };
}
