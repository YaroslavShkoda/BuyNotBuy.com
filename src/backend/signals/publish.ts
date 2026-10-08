import type { LiveSignal, SignalCandidate } from './lifecycle.js';
import { decideNext } from './lifecycle.js';
import type {
    SeriesKey,
    SignalLifecycleRepository,
    SignalStateRow,
} from './lifecycle.repository.js';
import { signalLifecycleRepository } from './lifecycle.repository.js';

/**
 * Puts the panel's opinion into the lifecycle, and is the other half of what
 * `reconcileSignalOutcomes` measures.
 *
 * **Both halves existed and neither was called.** The decision rules are a pure
 * function with no database behind it; the repository has a transactional
 * `write` and a `getLive`; the settlement loop ran on every poll and found
 * nothing, because nothing had ever published a signal to find. This is the
 * missing join, and it is deliberately thin: all the judgement lives in
 * `decideNext`, where it can be tested against the rule it is about rather than
 * against a fixture that also has to set up tables and rows.
 *
 * **The wall clock is not read here, and that is not an oversight.** The
 * lifecycle module states the rule itself — the current bar's timestamp and
 * price are inputs, because a rule that reaches for the clock cannot be
 * replayed over last month's data. Using `Date.now()` for `publishedAt` would
 * satisfy the column and quietly destroy that: replaying March would stamp
 * every signal with today, the transition trail would claim the signal moved on
 * dates the market was not trading, and nothing would look wrong. So the bar
 * decides when a signal was published, and only the bar.
 *
 * `candidate` is nullable and null is meaningful: it is a panel that has gone
 * quiet, and the lifecycle has rules about a signal whose panel disappeared —
 * expiry and invalidation are checked before the candidate gets a say precisely
 * so that silence cannot keep a dead signal alive. Passing a zero-confidence
 * candidate instead would be a different statement, and a wrong one.
 */
interface PublishSeries {
    readonly key: SeriesKey;
    readonly candidate: SignalCandidate | null;
    /** Milliseconds one bar spans. The same number the bars were built with. */
    readonly intervalMs: number;
    /**
     * The bar the system is looking at, whether or not the panel spoke.
     *
     * Required rather than optional because without it a null candidate makes
     * the distance to the live signal zero, the expiry branch unreachable, and
     * a signal that should have ended stays live indefinitely — the one thing
     * the lifecycle's own comment says it is built to prevent. Making it
     * required means the caller cannot forget it by omission.
     */
    readonly candleTimestamp: number;
    /**
     * The snapshot a signal was published from, and it is not replaced.
     *
     * A signal is measured from the bar it stood on, and the snapshot holding
     * that bar is what says which rule produced it. Updating the signal when
     * the market moves does not change either, so a republish keeps the
     * original link, and a close keeps it too — which is the case that bit:
     * the closing write had no snapshot of its own and was writing NULL over
     * the one the open had recorded, so every closed signal became
     * unattributable and every outcome row came back with a null rule.
     */
    readonly snapshotId?: string | null;
}

interface PublishResult {
    /** True when a row and a transition were written. */
    readonly written: boolean;
    /** What the lifecycle decided, when it decided anything. */
    readonly kind: string | null;
    readonly toStatus: string | null;
    readonly reason: string;
    /** The live row as it stands after this call, or null when there is none. */
    readonly live: SignalStateRow | null;
}

function toLiveSignal(row: SignalStateRow): LiveSignal {
    return {
        direction: row.direction,
        status: row.status,
        price: row.price,
        confidence: row.confidence,
        candleTimestamp: row.candleTimestamp,
    };
}

export async function publishSignal(
    series: PublishSeries,
    lifecycle: SignalLifecycleRepository = signalLifecycleRepository,
): Promise<PublishResult> {
    const previous = await lifecycle.getLive(series.key);
    const candidate = series.candidate;

    const decided = decideNext(
        previous === null ? null : toLiveSignal(previous),
        candidate,
        series.intervalMs,
        undefined,
        series.candleTimestamp,
    );

    if (!decided.recorded || decided.toStatus === null) {
        // Not an early return that hides work: `unchanged` is a real outcome
        // and the common one. Returning the previous row is what lets a caller
        // see that the signal is still there rather than inferring it from the
        // absence of a write.
        return {
            written: false,
            kind: decided.decision.kind,
            toStatus: decided.toStatus,
            reason: decided.reason,
            live: previous,
        };
    }

    // A closing decision describes the signal that was already there, so its
    // price and confidence are the live ones. An opening or an update describes
    // what the panel just said, so they are the candidate's. Taking the
    // candidate's price for an expiry would record a price the signal never
    // held, and the outcome engine would measure an entry that never happened.
    //
    // The two cases are written out rather than merged behind a boolean on
    // purpose: a merged version needs a non-null assertion on `candidate`,
    // because deciding from a flag means the compiler cannot narrow the thing
    // the assertion is about.
    const closing = decided.toStatus === 'EXPIRED' || decided.toStatus === 'INVALIDATED';

    if (closing) {
        if (previous === null) {
            // Unreachable through `decideNext`, which only reaches expire and
            // invalidate for a signal that exists. Stated rather than defaulted
            // to zero: a zero-price signal is a signal that can be measured, and
            // this one must not be invented.
            throw new Error(
                `lifecycle decided ${decided.toStatus} for a series with no live signal: ${series.key.symbol}`,
            );
        }

        const closed = await lifecycle.write(
            series.key,
            previous,
            {
                direction: previous.direction,
                status: decided.toStatus,
                snapshotId: previous.snapshotId,
                price: previous.price,
                confidence: previous.confidence,
                publishedAt: previous.candleTimestamp,
                candleTimestamp: previous.candleTimestamp,
            },
            // The bar stays the one the signal was standing on, because that is
            // what the outcome engine reads as the entry — moving it here would
            // measure a trade from a bar the signal never held. The transition
            // gets the current bar, which is when the end was actually noticed.
            { reason: decided.reason, createdAt: series.candleTimestamp },
        );

        return {
            written: true,
            kind: decided.decision.kind,
            toStatus: decided.toStatus,
            reason: decided.reason,
            live: closed,
        };
    }

    if (candidate === null) {
        // Also unreachable: `decideNext` returns `unchanged` for a null
        // candidate against a live signal, and `recorded` is false there.
        throw new Error(
            `lifecycle decided to write ${decided.toStatus} from an absent candidate: ${series.key.symbol}`,
        );
    }

    const live = await lifecycle.write(
        series.key,
        previous,
        {
            direction: candidate.direction,
            status: decided.toStatus,
            snapshotId: previous?.snapshotId ?? series.snapshotId ?? null,
            price: candidate.price,
            confidence: candidate.confidence,
            publishedAt: candidate.candleTimestamp,
            candleTimestamp: candidate.candleTimestamp,
        },
        { reason: decided.reason, createdAt: candidate.candleTimestamp },
    );

    return {
        written: true,
        kind: decided.decision.kind,
        toStatus: decided.toStatus,
        reason: decided.reason,
        live,
    };
}
