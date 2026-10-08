import type { Candle } from '../types/market.js';

/**
 * The contract every indicator is written against.
 *
 * It exists because "add an indicator" was previously a change to one
 * function, one interface, one API schema, one signal type, one row in the
 * dashboard and one branch of a switch — seven places, none of which fails
 * when any of the others is missed. The result is an indicator that computes,
 * never reaches a vote, and nobody notices for a release.
 *
 * So the parts an indicator is made of are declared once: what it needs to see,
 * what it produces, how much history it insists on, and whether it is allowed
 * to vote. A new indicator is one file and one line in the registry, and a
 * missing piece is a type error rather than a silence.
 */

/**
 * What an indicator is computed from.
 *
 * A context rather than a parameter list, because the inputs an indicator
 * needs are not a choice anyone should be making per call: the series, the
 * derived price arrays, and the market facts around them.
 */
interface IndicatorContext {
    /**
     * The series. Not readonly, because the calculators this was extracted
     * from take a mutable array and copying it once per indicator per request
     * is a real cost for a difference no caller can act on.
     */
    readonly candles: Candle[];
    /** `candles.map(c => c.close)`, built once for the whole run. */
    readonly closes: number[];
    readonly now: number;
    /**
     * Named intermediate series this indicator declared it needs, already
     * resolved.
     *
     * Resolved once for the whole run rather than per indicator, because two
     * indicators wanting the same series is the normal case and not the
     * exception — see `series.graph.ts` for what that saves and what it does
     * not.
     */
    readonly series: ReadonlyMap<string, unknown>;
}

/**
 * What an indicator produced.
 *
 * `value` is a number rather than a union because the interesting difference
 * between a trend indicator and a bounded oscillator is not the type, it is
 * what the vote is allowed to do with it. Making that a field means a new
 * indicator cannot be added without saying which side of that line it is on.
 */
export interface IndicatorValue {
    readonly value: number;
    /** Anything the indicator also wants a caller to see, such as bands. */
    readonly extra?: Readonly<Record<string, number>>;
}

type IndicatorRole =
    /** Takes a side. Enters the consensus. */
    | 'vote'
    /** Describes the market. Never enters the consensus. */
    | 'context';

export interface IndicatorDefinition {
    /**
     * Stable identity, independent of the display name and of the period.
     *
     * The performance table keys its history on this. A rename that changes
     * this key silently starts a new series and orphans every vote ever
     * recorded under the old one.
     */
    readonly key: string;
    /** Human-readable label, period included. Shown to a person. */
    readonly name: string;
    /** Whether this indicator votes, and what happens if it is missing. */
    readonly role: IndicatorRole;
    /** Bars this indicator needs before it will produce anything. */
    readonly warmup: number;
    /**
     * Named series this indicator needs, resolved for it.
     *
     * Declared rather than computed inline, so that the graph knows what to
     * work out before anything runs, and so a missing series is a registration
     * error rather than an undefined at request time.
     */
    readonly series?: readonly string[];
    readonly calculate: (context: IndicatorContext) => IndicatorValue;
}

/**
 * A registry that answers one question: what does this system know how to
 * compute?
 *
 * `list` exists so callers stop holding their own list. Every place that
 * enumerates indicators is a place to forget one, and the dashboard, the
 * consensus and the performance table each kept their own.
 */
export interface IndicatorRegistry {
    register(definition: IndicatorDefinition): void;
    get(key: string): IndicatorDefinition | undefined;
    /** Every registered indicator, in registration order. */
    list(): readonly IndicatorDefinition[];
    /** Only those allowed to vote. */
    voters(): readonly IndicatorDefinition[];
    /** Only those that describe the market. */
    contextual(): readonly IndicatorDefinition[];
    /**
     * Runs everything, keyed by indicator key.
     *
     * An indicator that cannot produce a value is reported as absent rather
     * than as a zero, because a zero is a number the consensus will happily
     * use and an absent one is a hole somebody has to look at.
     */
    calculate(context: IndicatorContext): Readonly<Record<string, IndicatorValue>>;
}

export function createIndicatorRegistry(): IndicatorRegistry {
    const definitions = new Map<string, IndicatorDefinition>();

    return {
        register(definition) {
            if (definitions.has(definition.key)) {
                // Silently replacing a definition would mean a vote recorded
                // under this key is now describing something else, and nothing
                // would say so.
                throw new Error(
                    `Indicator "${definition.key}" is already registered`,
                );
            }

            definitions.set(definition.key, definition);
        },

        get(key) {
            return definitions.get(key);
        },

        list() {
            return [...definitions.values()];
        },

        voters() {
            return this.list().filter((entry) => entry.role === 'vote');
        },

        contextual() {
            return this.list().filter((entry) => entry.role === 'context');
        },

        calculate(context) {
            const results: Record<string, IndicatorValue> = {};

            for (const definition of definitions.values()) {
                if (context.candles.length < definition.warmup) {
                    continue;
                }

                const value = definition.calculate(context);

                if (!Number.isFinite(value.value)) {
                    // Recorded as missing rather than written as a number, so
                    // the gap is visible instead of being averaged away.
                    continue;
                }

                results[definition.key] = value;
            }

            return results;
        },
    };
}

/**
 * Builds the context an indicator is computed from, once per run.
 *
 * **There used to be a third input, `price`, described as the close of the bar
 * in progress. It is gone, and its own description is the reason.**
 *
 * No indicator read it — checked by counting the context fields that are read at
 * all, which is `candles`, `closes` and `series` — while the only production
 * construction passed nothing and got `null`. So the field's documentation could
 * not be true of the system: no call site in the running service was able to
 * deliver the close of the bar in progress, and a context that advertises an
 * input and hands over null is the same defect as the one an optional logger
 * causes, one layer earlier. An indicator written tomorrow would reach for
 * `context.price` and get null, with no error and a plausible number out the
 * other side.
 *
 * It was removed rather than wired because the question it would have answered
 * is already answered deliberately and the answer is written down: %B is "where
 * the last close sits" between the bands, in `bollinger.ts`, using
 * `candles[candles.length - 1].close`. Making it the live price instead is a
 * change to what that indicator means, not a bug fix, and it belongs to whoever
 * decides that — the same owner as the other two open questions.
 */
export function indicatorContext(
    candles: readonly Candle[],
    now: number,
    series: ReadonlyMap<string, unknown> = new Map(),
): IndicatorContext {
    return {
        candles: [...candles],
        closes: candles.map((candle) => candle.close),
        now,
        series,
    };
}
