import type {
    LifecycleConfig,
    SignalDirection,
    SignalStatus,
} from '../config/lifecycle.config.js';
import { lifecycleConfig } from '../config/lifecycle.config.js';

/**
 * What the lifecycle engine decides, with nothing persisted.
 *
 * This is a pure function on purpose. The whole question — when is a signal the
 * same signal, when is it an update, when is it a reversal, when is it over —
 * is arithmetic over three numbers and a previous state, and the arithmetic is
 * where every interesting mistake lives. Keeping it free of a database means
 * each rule can be tested against the rule it is about rather than against a
 * fixture that also has to set up tables and rows.
 *
 * The caller is responsible for what it does with the decision. Nothing here
 * writes, and nothing here reads the clock: the current bar's timestamp and
 * price are inputs, because a rule that reaches for the wall clock cannot be
 * replayed over last month's data and a backtest that cannot be replayed is a
 * backtest that cannot be checked.
 */

export interface LiveSignal {
    readonly direction: SignalDirection;
    readonly status: SignalStatus;
    readonly price: number;
    readonly confidence: number;
    /** The bar the live signal was last written from. */
    readonly candleTimestamp: number;
}

export interface SignalCandidate {
    readonly direction: SignalDirection;
    readonly confidence: number;
    readonly price: number;
    /** The bar being evaluated. Must be a closed bar. */
    readonly candleTimestamp: number;
}

type SignalDecision =
    /** Nothing live, and the panel has an opinion: open a new signal. */
    | { readonly kind: 'open'; readonly direction: SignalDirection }
    /**
     * The panel wants a direction the live signal is not in.
     *
     * A reversal is a new signal even inside the cooldown: the setting exists
     * to stop the system re-entering a position it just left, and a market that
     * genuinely turned is the one event most worth recording.
     */
    | { readonly kind: 'reversal'; readonly direction: SignalDirection }
    /** The same direction, moved or convinced enough to be worth a new row. */
    | { readonly kind: 'update' }
    /** The same direction, within the noise: leave it alone. */
    | { readonly kind: 'unchanged' }
    /** The live signal has run out of bars. */
    | { readonly kind: 'expire' }
    /** The live signal has been stopped against itself. */
    | { readonly kind: 'invalidate' };

interface DecidedTransition {
    readonly decision: SignalDecision;
    readonly toStatus: SignalStatus | null;
    /** True when the decision must be written down as a transition. */
    readonly recorded: boolean;
    readonly reason: string;
}

function percentMove(from: number, to: number): number {
    return (Math.abs(to - from) / from) * 100;
}

function barsBetween(earlier: number, later: number, intervalMs: number): number {
    if (intervalMs <= 0) {
        return Number.NaN;
    }

    return Math.floor((later - earlier) / intervalMs);
}

function reason(decision: SignalDecision): string {
    switch (decision.kind) {
        case 'open':
            return `Открыт ${decision.direction}`;
        case 'reversal':
            return `Разворот в ${decision.direction}`;
        case 'update':
            return 'Обновлён: цена или уверенность изменились достаточно';
        case 'unchanged':
            return 'Без изменений';
        case 'expire':
            return 'Истёк срок сигнала';
        case 'invalidate':
            return 'Признан недействительным: цена пошла против';
    }
}

/**
 * Decides what should happen to the live signal for a series.
 *
 * Order matters and is not arbitrary. The live signal is checked for its own
 * end first — expiry and invalidation are properties of the signal that is
 * already there, and they do not depend on what the panel currently thinks.
 * Only then does the candidate get a say, because a panel that has gone quiet
 * must not keep a dead signal alive by accident.
 */
export function decideNext(
    live: LiveSignal | null,
    candidate: SignalCandidate | null,
    intervalMs: number,
    config: LifecycleConfig = lifecycleConfig,
    /**
     * The bar being evaluated, when the panel has no opinion to give.
     *
     * **This parameter exists because of a defect it fixes.** Expiry was
     * measured as bars between the live signal and `candidate?.candleTimestamp
     * ?? live.candleTimestamp`, so a null candidate collapsed the count to zero
     * and the expiry branch below could never be reached — a silent panel kept
     * a dead signal alive forever, which is the exact outcome the comment above
     * this function says it prevents. A caller that knows the current bar can
     * now say so; a caller that does not is unchanged, and still gets the old
     * answer rather than a silent expiry.
     */
    currentBarTimestamp?: number,
): DecidedTransition {
    if (live === null) {
        if (candidate === null) {
            return { decision: { kind: 'unchanged' }, toStatus: null, recorded: false, reason: 'Без изменений' };
        }

        return {
            decision: { kind: 'open', direction: candidate.direction },
            toStatus: 'GENERATED',
            recorded: true,
            reason: reason({ kind: 'open', direction: candidate.direction }),
        };
    }

    // The live signal's own end, checked before the candidate gets a say: a
    // panel that has gone quiet must not keep a dead signal alive, and expiry
    // and invalidation are properties of the signal that is already there.
    //
    // Invalidation is checked first on purpose. When a signal has both run out
    // of bars and gone against itself, "the market moved against this" is the
    // more informative of the two facts and the one the performance table
    // needs, and reporting EXPIRED would discard it in favour of a clock
    // reading. Expiry is still recorded on the transition, because the
    // transition carries the bar the signal was standing on and a reader can
    // see for themselves that the window had also run out.
    // The current bar, which is not the candidate's bar: a panel that has gone
    // quiet has no bar of its own, and falling back to the live signal's own
    // timestamp measured the distance as zero, so a signal could never expire.
    const bar = currentBarTimestamp ?? candidate?.candleTimestamp ?? live.candleTimestamp;
    const bars = barsBetween(live.candleTimestamp, bar, intervalMs);

    const hasFailed =
        candidate !== null &&
        percentMove(live.price, candidate.price) >= config.invalidationPercent;

    if (hasFailed && (live.direction === 'LONG' ? candidate.price < live.price : candidate.price > live.price)) {
        return {
            decision: { kind: 'invalidate' },
            toStatus: 'INVALIDATED',
            recorded: true,
            reason: reason({ kind: 'invalidate' }),
        };
    }

    if (Number.isFinite(bars) && bars >= config.expiryBars) {
        return {
            decision: { kind: 'expire' },
            toStatus: 'EXPIRED',
            recorded: true,
            reason: reason({ kind: 'expire' }),
        };
    }

    if (candidate === null || candidate.direction !== live.direction) {
        if (candidate === null) {
            return { decision: { kind: 'unchanged' }, toStatus: null, recorded: false, reason: 'Без изменений' };
        }

        // A reversal is never blocked. See the config comment: cooldown exists
        // to stop re-entry, and blocking a real turn would silence the one
        // event most worth recording.
        return {
            decision: { kind: 'reversal', direction: candidate.direction },
            toStatus: 'GENERATED',
            recorded: true,
            reason: reason({ kind: 'reversal', direction: candidate.direction }),
        };
    }

    const moved = percentMove(live.price, candidate.price) >= config.republishPriceMovePercent;
    const convinced =
        Math.abs(candidate.confidence - live.confidence) >= config.republishConfidenceDelta;

    if (moved || convinced) {
        return {
            decision: { kind: 'update' },
            toStatus: 'UPDATED',
            recorded: true,
            reason: reason({ kind: 'update' }),
        };
    }

    return { decision: { kind: 'unchanged' }, toStatus: null, recorded: false, reason: 'Без изменений' };
}

/**
 * Whether a closed signal may be replaced by another in the same direction.
 *
 * Separate from `decideNext` because it is a question about a *closed* signal
 * and its predecessor, not about a live one, and because it is the rule most
 * likely to be quietly broken by a later change: it is a single boolean on a
 * path that runs on every poll.
 */
export function cooldownBlocks(
    lastClosedCandleTimestamp: number,
    nowCandleTimestamp: number,
    intervalMs: number,
    bars: number = lifecycleConfig.cooldownBars,
): boolean {
    if (bars <= 0) {
        return false;
    }

    const elapsed = barsBetween(lastClosedCandleTimestamp, nowCandleTimestamp, intervalMs);

    return Number.isFinite(elapsed) && elapsed < bars;
}
