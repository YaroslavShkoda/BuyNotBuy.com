/**
 * The seam between resolved outcomes and the performance layer.
 *
 * **This layer had 854 lines of code, 1154 lines of tests and no caller at
 * all** — not even a command line. Everything it computes about whether the
 * system's published confidence is honest had no way of being asked, which is
 * a more serious state than having no such code: the tests say it works, the
 * architecture map says it is stranded, and neither produces a number.
 *
 * **The mapping is where future leakage would enter, so it is the part with the
 * most to say about itself.** A performance table is only honest if every
 * sample in it is an outcome whose window had already closed when the table was
 * asked for. A sample resolved *after* the fact and included anyway produces a
 * table that is not wrong in any way a reader can see: the arithmetic is right,
 * the sample is just from the future.
 *
 * So the horizon is not a default the caller can leave off. It is named, and a
 * caller that does not say which one is asking a question this layer cannot
 * answer — "how were you doing" is a different question at 1h than at 24h, and
 * answering one with the other is how a system ends up reporting a number for a
 * horizon it never ran.
 */

import type { HorizonOutcome, SignalOutcome } from '../outcomes/outcome.js';
import type {
    PerformanceSample,
} from './performance.js';

/**
 * A horizon, and whether its window had closed by the moment asked.
 *
 * `closed` is a claim about the *window*, not about the data: a signal is
 * resolved at a horizon when enough bars exist after entry for the outcome to
 * mean anything, and the verdict `expired` is precisely the record of one where
 * they did not.
 */
interface ResolvedHorizon {
    readonly bars: number;
    readonly outcome: HorizonOutcome;
    /** Whether this horizon may be used, judged at `asOf`. */
    readonly usable: boolean;
    readonly reason?: 'unresolved' | 'expired';
}

export interface HorizonSelector {
    /** The window to measure, in bars. Named so it cannot be left implicit. */
    readonly bars: number;
    /** The moment the table is being asked for. */
    readonly asOf: number;
    /**
     * How long after the last bar a window stays open.
     *
     * Zero means it closes the moment its last bar is in. A market that has not
     * published the closing bar yet has not finished the window, and counting
     * it anyway is how a partially-formed horizon is scored as a flat.
     */
    readonly graceMs: number;
}

/**
 * What the system published when it produced the signal.
 *
 * **Kept separate from the outcome on purpose, and this is the point of the
 * whole file.** An outcome knows how the market went; it does not know what the
 * system claimed at the time, and joining the two into one record is how a
 * calibration table ends up calibrating itself against information that only
 * became available after the claim. The confidence is a *prior* reading, so it
 * has to travel as one — carried by the caller from the published record and
 * never recomputed from what followed.
 */
export interface PublishedSignal {
    /** The confidence the system published, 0..100. */
    readonly confidence: number;
    readonly regime?: string | null;
    readonly indicators?: readonly string[];
}

/** One measured signal: what was claimed, and what the market did. */
export interface OutcomeWithPublication {
    readonly outcome: SignalOutcome;
    readonly published: PublishedSignal;
}

/**
 * The result of measuring a set of outcomes, with everything excluded named.
 *
 * The excluded count is not decoration. A table that silently drops half its
 * rows and reports the rest as "the performance" is the most dangerous shape
 * this function can return, because every number in it is true.
 */
interface PerformanceReport {
    readonly samples: readonly PerformanceSample[];
    /** Resolved signals that were measured. */
    readonly measured: number;
    /** Signals left out, and how many of each kind. */
    readonly excluded: {
        readonly total: number;
        readonly unresolved: number;
        readonly expired: number;
        readonly otherHorizon: number;
    };
}

/** Whether a horizon's window had closed by `asOf`. */
export function windowClosed(
    outcome: SignalOutcome,
    horizon: HorizonSelector,
): boolean {
    const bars = horizon.bars * 60 * 60 * 1000;

    if (horizon.graceMs < 0) {
        throw new Error(
            'graceMs must not be negative: a window cannot close before its last bar.',
        );
    }

    return outcome.entryTimestamp + bars + horizon.graceMs <= horizon.asOf;
}

/**
 * Resolves one outcome at a named horizon, or says why it cannot be used.
 *
 * The reasons stay apart because they mean different things to a reader. A
 * signal that has not resolved yet is a statement about now; one that expired is
 * a statement about the market running out of bars, which is a property of the
 * sample and is exactly the kind of thing a performance table hides by
 * averaging.
 */
export function resolveAtHorizon(
    outcome: SignalOutcome,
    horizon: HorizonSelector,
): ResolvedHorizon {
    const found = outcome.horizons.find((entry) => entry.bars === horizon.bars);

    if (found === undefined) {
        throw new Error(
            `Outcome for ${outcome.symbol} at ${outcome.entryTimestamp} has no horizon of ` +
                `${horizon.bars} bars. Measuring at a horizon nobody ran is how a system ` +
                'reports a number for an experiment it did not perform.',
        );
    }

    if (found.verdict === 'unknown') {
        return { bars: horizon.bars, outcome: found, usable: false, reason: 'unresolved' };
    }

    if (found.verdict === 'expired') {
        return { bars: horizon.bars, outcome: found, usable: false, reason: 'expired' };
    }

    if (!windowClosed(outcome, horizon)) {
        return { bars: horizon.bars, outcome: found, usable: false, reason: 'unresolved' };
    }

    return { bars: horizon.bars, outcome: found, usable: true };
}

/**
 * Turns resolved outcomes into samples, dropping what cannot be measured and
 * counting what it dropped.
 */
export function toPerformanceSamples(
    measured: readonly OutcomeWithPublication[],
    horizon: HorizonSelector,
): PerformanceReport {
    const samples: PerformanceSample[] = [];
    let unresolved = 0;
    let expired = 0;
    let otherHorizon = 0;

    for (const { outcome, published } of measured) {
        if (!outcome.horizons.some((entry) => entry.bars === horizon.bars)) {
            otherHorizon += 1;

            continue;
        }

        const resolved = resolveAtHorizon(outcome, horizon);

        if (!resolved.usable) {
            if (resolved.reason === 'expired') {
                expired += 1;
            } else {
                unresolved += 1;
            }

            continue;
        }

        samples.push({
            // Carried, not inferred. `SignalOutcome` knows the market and it is
            // the only place that does; a sample that did not carry it would
            // make every aggregate below a blend that no caller could see.
            symbol: outcome.symbol,
            timestamp: outcome.entryTimestamp,
            direction: outcome.direction,
            verdict: resolved.outcome.verdict,
            returnFraction: resolved.outcome.returnFraction,
            confidence: published.confidence,
            // `exactOptionalPropertyTypes` is on, so these cannot be passed as
            // `undefined` — and that is the behaviour worth keeping. A sample
            // carrying `regime: undefined` reads downstream as a measurement of
            // "no regime" rather than "not recorded", and the two lead to
            // different conclusions about a strategy.
            ...(published.regime !== undefined ? { regime: published.regime } : {}),
            ...(published.indicators !== undefined
                ? { indicators: published.indicators }
                : {}),
        });
    }

    return {
        samples,
        measured: samples.length,
        excluded: {
            total: unresolved + expired + otherHorizon,
            unresolved,
            expired,
            otherHorizon,
        },
    };
}
