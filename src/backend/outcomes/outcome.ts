import type { OutcomeConfig } from '../config/outcome.config.js';
import { outcomeConfig } from '../config/outcome.config.js';
import type { Candle } from '../types/market.js';

/**
 * What became of a signal, measured strictly after it was published.
 *
 * This is the only place in the system allowed to say whether a signal was
 * right, and the reason it is a separate module with no dependency on the
 * signal path is the point. A signal that could check its own homework would be
 * measuring itself against a series that already knows the answer, and every
 * number downstream — the performance table, the calibration curve, the
 * decision to promote a new strategy — inherits that error rather than
 * catching it.
 *
 * The measurement window starts at the bar *after* the signal. A signal
 * published on the close of a bar and measured on that same close is a
 * measurement of the price it was given, not of the market's reaction to it,
 * and every strategy that scores well on that basis is a strategy that got
 * lucky in a way nobody can reproduce.
 */

/**
 * Whether the signal was right, at one horizon.
 *
 * Five outcomes rather than three, and the extra two are the ones that make
 * the table honest. A signal whose window has not closed yet is `unknown`, and
 * a signal that never got the chance is `expired`; both would otherwise be
 * scored as losses by any code that treats "not a win" as "not right", and
 * that is how a table of a hundred signals ends up reporting a 40% hit rate
 * when the truth is a 40% hit rate over the sixty that had actually resolved.
 */
export type OutcomeVerdict =
    | 'correct'
    | 'incorrect'
    | 'neutral'
    /** Within the breakeven band: neither paid nor cost. */
    | 'flat'
    /** The window has not closed yet. */
    | 'unknown'
    /** The series ended before the window did. */
    | 'expired';

export interface HorizonOutcome {
    readonly bars: number;
    /** Return as a fraction, not a percentage: 0.05 is five percent. */
    readonly returnFraction: number | null;
    /**
     * Most favourable excursion over the window, as a fraction.
     *
     * A long signal's best case and a short one's are not the same number: the
     * best a short could have done is the *fall* in price, not the rise. A
     * single signed field gets that wrong half the time, so it is measured
     * from the entry in the direction the signal was pointing.
     */
    readonly maxFavourable: number | null;
    /** Least favourable excursion over the window, as a fraction. */
    readonly maxAdverse: number | null;
    readonly verdict: OutcomeVerdict;
}

export interface SignalOutcome {
    readonly symbol: string;
    readonly entryTimestamp: number;
    readonly entryPrice: number;
    readonly direction: 'LONG' | 'SHORT';
    readonly horizons: readonly HorizonOutcome[];
    /**
     * How the signal ended, when it has.
     *
     * Carried through so a performance table can separate a signal that was
     * stopped from one that ran out of time — they are different failures and
     * averaging them together hides the one that is fixable.
     */
    readonly closedBy: 'invalidated' | 'expired' | 'reversed' | null;
}

/**
 * The remaining outcome types PHASE 12.1 asks for, read off a stored horizon.
 *
 * `hit target` and `hit stop` are not columns, and adding them as columns would
 * be the mistake this file's configuration is written to prevent. A target is
 * policy — a number somebody chose — and the whole argument of
 * `breakevenPercent` is that a measurement stays a measurement and a cost
 * model stays an assumption, so that a performance table can be recomputed when
 * the fee schedule changes rather than having to be re-measured. Baking "the
 * target was 2%" into the row would make every stored outcome wrong the moment
 * somebody decided the target was 2.5%.
 *
 * So they are asked instead, afterwards, from the excursion that was recorded:
 * if the best the price did over the window was at least the target, the target
 * was reached — and *which* of the two happened first is deliberately not
 * answered, because a stored maximum cannot say that, and an answer that
 * guessed would be worse than no answer.
 */
interface ExcursionQuestion {
    /** How far, as a fraction of the entry price, for the target. */
    readonly targetFraction: number;
    /** How far, as a positive fraction, for the stop. */
    readonly stopFraction: number;
}

interface ExcursionAnswers {
    /** True only when the excursions were recorded at all. */
    readonly answered: boolean;
    readonly hitTarget: boolean;
    readonly hitStop: boolean;
    /** How far the target was left short, as a fraction. Zero when it was hit. */
    readonly missedTargetBy: number;
}

export function readExcursions(
    horizon: HorizonOutcome,
    question: ExcursionQuestion,
): ExcursionAnswers {
    if (horizon.maxFavourable === null || horizon.maxAdverse === null) {
        // Not "no" — unanswered. Reporting `false` here would make a table of
        // targets look like a table where nothing reached one, which is the
        // failure this module exists to avoid in the other direction.
        return {
            answered: false,
            hitTarget: false,
            hitStop: false,
            missedTargetBy: question.targetFraction,
        };
    }

    const hitTarget = horizon.maxFavourable >= question.targetFraction;
    const hitStop = horizon.maxAdverse <= -question.stopFraction;

    return {
        answered: true,
        hitTarget,
        hitStop,
        missedTargetBy: hitTarget ? 0 : question.targetFraction - horizon.maxFavourable,
    };
}

interface OutcomeInput {
    readonly symbol: string;
    /** The bar the signal was published on. */
    readonly entryTimestamp: number;
    readonly entryPrice: number;
    readonly direction: 'LONG' | 'SHORT';
    /**
     * Every bar from the signal onwards, oldest first.
     *
     * Anything before `entryTimestamp` is ignored outright rather than looked
     * at and discarded: a function that reads a series it does not use is a
     * function one edit away from reading one it should not.
     */
    readonly candles: readonly Candle[];
    readonly closedBy?: SignalOutcome['closedBy'];
    readonly config?: OutcomeConfig;
}

function forwardFraction(
    direction: 'LONG' | 'SHORT',
    from: number,
    to: number,
): number {
    // Signed in the direction of the signal. A long that gained five percent
    // and a short that fell five percent are the same result, and a table that
    // stores raw returns has to reconstruct the direction every time it reads
    // one back.
    const raw = (to - from) / from;

    return direction === 'LONG' ? raw : -raw;
}

function verdictOf(
    value: number,
    breakeven: number,
): OutcomeVerdict {
    if (value > breakeven) {
        return 'correct';
    }

    if (value < -breakeven) {
        return 'incorrect';
    }

    return 'flat';
}

/**
 * Measures one signal.
 *
 * `unknown` and `expired` are distinguished deliberately. A window that has not
 * closed is a question waiting for an answer, and a series that ran out before
 * the window did is a signal that will never get one. Collapsing both into
 * `unknown` makes a table of unresolved signals look like a table of broken
 * ones, and a table of broken ones looks like a strategy that does not work.
 */
export function measureOutcome(input: OutcomeInput): SignalOutcome {
    const config = input.config ?? outcomeConfig;
    const breakeven = config.breakevenPercent / 100;

    const forward = input.candles.filter(
        (candle) => candle.timestamp > input.entryTimestamp,
    );

    const horizons: HorizonOutcome[] = config.horizons.map((bars) => {
        // `bars` counts forward from the entry, so the last bar of a
        // one-bar horizon is the one immediately after the signal. Indexing at
        // `bars - 1` rather than `bars` is what keeps a signal from being
        // scored on the price it was handed.
        const end = forward[bars - 1];

        if (end === undefined) {
            return {
                bars,
                returnFraction: null,
                maxFavourable: null,
                maxAdverse: null,
                verdict: forward.length === 0 ? 'expired' : 'unknown',
            };
        }

        const window = forward.slice(0, bars);
        const value = forwardFraction(
            input.direction,
            input.entryPrice,
            end.close,
        );

        let maxFavourable: number | null = null;
        let maxAdverse: number | null = null;

        if (config.trackExcursions) {
            const excursions = window.map((candle) =>
                forwardFraction(input.direction, input.entryPrice, candle.close),
            );

            maxFavourable = Math.max(...excursions);
            maxAdverse = Math.min(...excursions);
        }

        return {
            bars,
            returnFraction: value,
            maxFavourable,
            maxAdverse,
            verdict: verdictOf(value, breakeven),
        };
    });

    return {
        symbol: input.symbol,
        entryTimestamp: input.entryTimestamp,
        entryPrice: input.entryPrice,
        direction: input.direction,
        horizons,
        closedBy: input.closedBy ?? null,
    };
}
