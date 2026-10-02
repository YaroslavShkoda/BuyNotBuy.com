import { signalLifecycleRepository } from '../signals/lifecycle.repository.js';
import { outcomeRepository } from '../outcomes/outcome.repository.js';

import type { SignalLifecycleRepository } from '../signals/lifecycle.repository.js';
import type { OutcomeRepository } from './outcome.repository.js';
import type { Candle } from '../types/market.js';
import type { SeriesKey } from '../signals/lifecycle.repository.js';

/**
 * Turns closed signals into measurements, and is the reason the performance
 * layer has anything to read.
 *
 * **This is a pull, not a push, and the shape was already decided by the
 * repository underneath.** `OutcomeRepository.unresolved` exists to list what is
 * still waiting for bars, and `settle` is documented as updating a signal in
 * place rather than adding a second measurement of it. Both only make sense for
 * a loop that runs again after new candles arrive and finishes the windows that
 * have since closed — which is exactly what a polling cycle is. Nothing here
 * decides *when* a horizon has closed; that belongs to the measurement, and
 * `measureOutcome` already distinguishes a window that is still open from one
 * that never will close.
 *
 * The alternative — settling at record time — is the mistake the `settle`
 * comment is written against. A signal published on the close of a bar has no
 * outcome at that moment, so record-time settlement writes a row of `unknown`
 * and nothing ever revisits it, and a table where every row says "not measured"
 * is indistinguishable from a table where every signal failed.
 *
 * Both dependencies are parameters so a test can drive this without a database
 * and so the caller is explicit about what it is reconciling. `series` is
 * required rather than defaulted: a settler that guessed its market would
 * measure the wrong one, and the series key is the thing that makes a
 * measurement attributable.
 */
export interface SettleSeries {
    readonly key: SeriesKey;
    /** Every bar available now, oldest first. Anything before an entry is ignored. */
    readonly candles: readonly Candle[];
    /** How many closed signals to revisit per pass. */
    readonly limit?: number;
    readonly now?: number;
    /**
     * The rule the caller knows produced these signals. Optional only because
     * it can be resolved from the signal's own snapshot — see below — and
     * optional is a hazard worth naming, so the fallback is the only way to
     * reach a null version.
     */
    readonly strategyVersionId?: number | null;
    readonly regime?: string | null;
    readonly dataQuality?: number | null;
}

export interface SettleReport {
    /** Closed signals this pass looked at. */
    readonly examined: number;
    /** Rows written, horizons included: one signal at seven horizons is seven. */
    readonly rows: number;
    /** Signals still waiting for bars after this pass. */
    readonly stillWaiting: number;
}

/**
 * How a signal's terminal state names why it ended.
 *
 * **This is a reading, not a fact, and it is worth saying so.** The lifecycle
 * closes a signal as `INVALIDATED`, `EXPIRED` or `CLOSED`; the outcome row
 * records `invalidated`, `expired` or `reversed`. Two of those pair by name. The
 * third has no counterpart — `CLOSED` says *that* it ended and not *why* — and
 * `reversed` is the only word left in the outcome vocabulary, so the bijection
 * is forced.
 *
 * Nothing has ever written `reversed`: it exists in the type, in the database
 * CHECK and in every reader, and no code path produces it. If the reading is
 * wrong, this function is the only place to change, and the test below says
 * which three words are being asserted.
 */
export function closedByFor(status: string): 'invalidated' | 'expired' | 'reversed' {
    if (status === 'INVALIDATED') {
        return 'invalidated';
    }

    if (status === 'EXPIRED') {
        return 'expired';
    }

    return 'reversed';
}

/**
 * The strategy version behind a snapshot, resolved by the caller.
 *
 * **Injected rather than imported, and that is a layering rule rather than a
 * style one.** Reading the version means reading a snapshot, and the snapshot
 * repository lives in `analysis`. An import from here would be
 * `outcomes → analysis`, which the layering lint refuses — and it would be
 * right to refuse: the outcome engine has no business knowing how snapshots
 * are stored. The dependency arrives as a function, so the answer comes from
 * whoever is allowed to produce it.
 *
 * Returns null rather than a guess. A signal published before migration 18 has
 * no snapshot, a snapshot can be pruned, and a caller can pass a version that
 * no longer exists — in every case the honest answer is "unknown", and writing
 * a plausible version instead would attach a measurement to a rule on the
 * strength of a coincidence.
 */
export type VersionResolver = (snapshotId: string) => Promise<number | null>;

export async function reconcileSignalOutcomes(
    series: SettleSeries,
    lifecycle: SignalLifecycleRepository = signalLifecycleRepository,
    outcomes: OutcomeRepository = outcomeRepository,
    /**
     * Optional, and omitting it is a real choice rather than a default:
     * measurements are then written with no rule attached, which shows up as
     * NULL in `signal_outcome.strategy_version_id` and can be counted. The
     * alternative — a resolver that returns null from inside this module —
     * would have needed the import the layering lint forbids.
     */
    resolveVersion?: VersionResolver,
): Promise<SettleReport> {
    const closed = await lifecycle.closed(series.key, series.limit);
    const now = series.now ?? Date.now();

    let rows = 0;

    for (const signal of closed) {
        // The version is the one the signal was *published from*, never the one
        // active now. When the fallback is active those are different rules,
        // and crediting the outcome to the active one would hand the promotion
        // gate statistics from a rule that did not produce the trade.
        const version =
            series.strategyVersionId ??
            (resolveVersion === undefined || signal.snapshotId === null
                ? null
                : await resolveVersion(signal.snapshotId));

        const settled = await outcomes.settle({
            key: series.key,
            stateId: Number(signal.id),
            direction: signal.direction,
            entryTimestamp: signal.candleTimestamp,
            entryPrice: signal.price,
            closedBy: closedByFor(signal.status),
            // Passed whole, not sliced. The entry timestamp is what defines the
            // start of the window and `measureOutcome` filters on it, so
            // slicing here would mean computing the same boundary twice and
            // trusting the two to agree.
            candles: series.candles,
            regime: series.regime ?? null,
            dataQuality: series.dataQuality ?? null,
            strategyVersionId: version,
            now,
        });

        rows += settled.length;
    }

    // Scoped to this series, because the report is this market's and the field
    // beside it — `market`, added by the caller — says so. It used to count every
    // market's backlog and report it as this one's, truncated at a limit it no
    // longer needs.
    const waiting = await outcomes.countUnresolved(series.key);

    return {
        examined: closed.length,
        rows,
        stillWaiting: waiting,
    };
}
