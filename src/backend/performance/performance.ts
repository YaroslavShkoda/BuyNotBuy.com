import { performanceConfig } from './performance.config.js';

import type { PerformanceConfig } from './performance.config.js';
import type { OutcomeVerdict } from '../outcomes/outcome.js';

/**
 * What a set of resolved signals says about the system that produced them.
 *
 * Pure arithmetic over measurements, with no database and no clock, because
 * every interesting bug in a performance table is in the arithmetic and a
 * function that cannot be handed an array of rows cannot be checked against
 * one.
 *
 * Rates come back nullable rather than zero. A bucket with three signals in it
 * has no hit rate, and reporting 0% for it claims the system is wrong in that
 * range — a different sentence from "there is not enough to say", and one a
 * dashboard will happily turn into a red number either way.
 */

/** One resolved signal, as the performance layer sees it. */
export interface PerformanceSample {
    /**
     * The market this row was measured on.
     *
     * Required rather than optional, which is the whole content of the field.
     * It used to be absent entirely, and everything downstream — the metrics,
     * the confidence buckets, the regime and indicator cuts — computed over a
     * set that no longer knew which market each row came from. The blend was
     * live in the type and latent only because the single caller loaded one
     * market: a report over two markets would have had every individual number
     * correct and answered a question nobody asked.
     *
     * PHASE 13 lists an asset cut among the slices of a performance table, and
     * `groupBy` already takes an arbitrary key, so with this field the cut is
     * `groupBy(samples, (sample) => sample.symbol)`.
     */
    readonly symbol: string;
    readonly timestamp: number;
    readonly direction: 'LONG' | 'SHORT';
    readonly verdict: OutcomeVerdict;
    /**
     * Return as a fraction, signed in the direction of the signal.
     *
     * Null for anything unresolved. A null return averaged as zero would pull
     * the expectancy towards a number the market never produced.
     */
    readonly returnFraction: number | null;
    /** The confidence the system published this signal with, 0..100. */
    readonly confidence: number;
    readonly regime?: string | null;
    /** Which indicators were pointing this way when it was published. */
    readonly indicators?: readonly string[];
}

export interface Metrics {
    /** Resolved signals only. Unresolved ones are counted, not scored. */
    readonly total: number;
    readonly correct: number;
    readonly incorrect: number;
    readonly flat: number;
    /** Not yet resolved. Reported so a reader can see the sample is partial. */
    readonly unresolved: number;
    /** null when the resolved sample is below the configured floor. */
    readonly accuracy: number | null;
    /** Mean signed return per resolved signal. null below the floor. */
    readonly expectancy: number | null;
    /**
     * Gross profit over gross loss.
     *
     * null when there were no losses at all. Infinite is the true value and is
     * not reportable: a table that prints "∞" reads as a bug, and a table that
     * prints a large finite number reads as a real ratio.
     */
    readonly profitFactor: number | null;
    /** Share of resolved signals that were directionally right. */
    readonly directionAccuracy: number | null;
    /**
     * Deepest fall from a running peak of the cumulative return, as a
     * positive number.
     *
     * Reported as a positive magnitude because a drawdown of minus thirty
     * percent and a drawdown of thirty percent are the same event and only one
     * of the two reads correctly.
     */
    readonly maxDrawdown: number | null;
    /**
     * Mean return divided by the standard deviation of returns.
     *
     * Not a Sharpe ratio and not called one: the numerator is a per-signal
     * mean rather than an excess over a risk-free rate, and the denominator is
     * over signals rather than over time. It is comparable across strategies
     * measured the same way, which is all it is used for here, and calling it
     * Sharpe would claim a number it has not earned.
     */
    readonly sharpeLike: number | null;
    /** True when the sample is too small for the rates above to mean anything. */
    readonly undersampled: boolean;
}

export const EMPTY_METRICS: Metrics = {
    total: 0,
    correct: 0,
    incorrect: 0,
    flat: 0,
    unresolved: 0,
    accuracy: null,
    expectancy: null,
    profitFactor: null,
    directionAccuracy: null,
    maxDrawdown: null,
    sharpeLike: null,
    undersampled: true,
};

function isResolved(sample: PerformanceSample): boolean {
    return sample.verdict === 'correct' || sample.verdict === 'incorrect' || sample.verdict === 'flat';
}

/**
 * Computes the metrics over a set of samples.
 *
 * Samples are sorted by time rather than assumed to arrive in order. Every
 * time-dependent figure here — the drawdown above all — is meaningless in a
 * different order, and a caller that had to remember to sort before calling
 * would eventually forget.
 */
export function computeMetrics(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
): Metrics {
    let correct = 0;
    let incorrect = 0;
    let flat = 0;
    let unresolved = 0;

    for (const sample of samples) {
        if (sample.verdict === 'correct') {
            correct += 1;
        } else if (sample.verdict === 'incorrect') {
            incorrect += 1;
        } else if (sample.verdict === 'flat') {
            flat += 1;
        } else {
            unresolved += 1;
        }
    }

    const resolved = samples.filter(
        (sample): sample is PerformanceSample & { returnFraction: number } =>
            isResolved(sample) && sample.returnFraction !== null,
    );

    const total = correct + incorrect + flat;
    const undersampled = total < config.minimumSample;

    if (undersampled) {
        // The counts are still reported. Knowing there are four signals is
        // useful; knowing they hit 75% is not.
        //
        // `total` included, and deliberately: a bucket that reports four
        // correct signals and a total of zero is a bucket that cannot be added
        // up, and a performance table whose parts do not sum to its sample
        // cannot be checked by anyone reading it.
        return {
            ...EMPTY_METRICS,
            total,
            correct,
            incorrect,
            flat,
            unresolved,
            undersampled: true,
        };
    }

    let grossProfit = 0;
    let grossLoss = 0;
    let sum = 0;

    for (const sample of resolved) {
        sum += sample.returnFraction;

        if (sample.returnFraction > 0) {
            grossProfit += sample.returnFraction;
        } else if (sample.returnFraction < 0) {
            grossLoss += -sample.returnFraction;
        }
    }

    const mean = resolved.length === 0 ? 0 : sum / resolved.length;
    const variance =
        resolved.length < 2
            ? 0
            : resolved.reduce(
                  (acc, sample) =>
                      acc + (sample.returnFraction - mean) ** 2,
                  0,
              ) / (resolved.length - 1);
    const deviation = Math.sqrt(variance);

    const ordered = [...resolved].sort((a, b) => a.timestamp - b.timestamp);
    let equity = 0;
    let peak = 0;
    let drawdown = 0;

    for (const sample of ordered) {
        equity += sample.returnFraction;

        if (equity > peak) {
            peak = equity;
        }

        const fromPeak = peak - equity;

        if (fromPeak > drawdown) {
            drawdown = fromPeak;
        }
    }

    return {
        total,
        correct,
        incorrect,
        flat,
        unresolved,
        accuracy: correct / total,
        expectancy: mean,
        // null rather than Infinity when nothing was lost: a ratio with no
        // denominator is not a large ratio, and printing one is a lie that
        // sorts correctly.
        profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
        directionAccuracy:
            correct + incorrect === 0
                ? null
                : correct / (correct + incorrect),
        maxDrawdown: drawdown,
        sharpeLike: deviation === 0 ? null : mean / deviation,
        undersampled: false,
    };
}

export interface Bucket {
    readonly label: string;
    readonly from: number;
    readonly to: number;
    readonly metrics: Metrics;
}

export interface ConfidenceBuckets {
    readonly buckets: readonly Bucket[];
    /**
     * How much of the sample the buckets could not place.
     *
     * Always zero, because the config refuses edges that do not start at 0 and
     * end at 100 — and reported anyway, because a number that has to be zero
     * by construction is a number that should be checked rather than assumed.
     */
    readonly unplaced: number;
}

/**
 * Groups by published confidence.
 *
 * Built to answer a question that is uncomfortable for the system to hear: is a
 * higher confidence actually a better signal? Nothing here sorts the buckets by
 * rate or asserts a trend, and a table that did would be reporting the shape
 * of its own sample as a property of the strategy. The buckets are presented
 * in confidence order and whatever they show is what they show.
 */
export function confidenceBuckets(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
): ConfidenceBuckets {
    const { confidenceEdges } = config;
    const buckets: Bucket[] = [];
    let unplaced = 0;

    for (let index = 0; index < confidenceEdges.length - 1; index += 1) {
        const from = confidenceEdges[index] ?? 0;
        const to = confidenceEdges[index + 1] ?? 100;

        // Lower edge inclusive, upper edge exclusive, except for the last
        // bucket which takes everything up to and including 100. Without that,
        // a signal published at exactly 100 falls out of the table entirely.
        const inBucket = samples.filter((sample) =>
            index === confidenceEdges.length - 2
                ? sample.confidence >= from && sample.confidence <= to
                : sample.confidence >= from && sample.confidence < to,
        );

        buckets.push({
            label: `${from}-${to}`,
            from,
            to,
            metrics: computeMetrics(inBucket, config),
        });
    }

    for (const sample of samples) {
        const placed = buckets.some(
            (bucket) =>
                sample.confidence >= bucket.from && sample.confidence <= bucket.to,
        );

        if (!placed) {
            unplaced += 1;
        }
    }

    return { buckets, unplaced };
}

export type GroupedPerformance = ReadonlyMap<string, Metrics>;

/**
 * Groups by any key, skipping absent values.
 *
 * A signal with no regime is not in the group for regime "null" — it is in no
 * group, and the difference matters: a null bucket is a claim that the system
 * behaves one way when it does not know what market it is in, and it would sit
 * next to a real regime in a chart looking like a comparable sample.
 */
export function groupBy(
    samples: readonly PerformanceSample[],
    key: (sample: PerformanceSample) => string | null | undefined,
    config: PerformanceConfig = performanceConfig,
): GroupedPerformance {
    const groups = new Map<string, PerformanceSample[]>();

    for (const sample of samples) {
        const name = key(sample);

        if (name === null || name === undefined || name === '') {
            continue;
        }

        const bucket = groups.get(name);

        if (bucket === undefined) {
            groups.set(name, [sample]);
        } else {
            bucket.push(sample);
        }
    }

    return new Map(
        [...groups].map(([name, group]) => [name, computeMetrics(group, config)]),
    );
}

export interface IndicatorPerformance {
    readonly metrics: Metrics;
    /** Signals this indicator was part of. */
    readonly withIndicator: number;
    /**
     * Signals this indicator was pointed against, or absent from.
     *
     * Reported because the question "how often is the EMA right on its own" is
     * not the same as "how often is it right when it agrees with the rest", and
     * answering only the second is how an indicator that is right fifty percent
     * of the time in isolation gets presented as an eighty percent one.
     */
    readonly withoutIndicator: number;
}

/**
 * Per-indicator breakdown.
 *
 * Every indicator is reported with both its hits and its misses, not just the
 * ones where it was right. An indicator table showing only agreeing signals is
 * indistinguishable from one showing the truth.
 */
export function byIndicator(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
): ReadonlyMap<string, IndicatorPerformance> {
    const names = new Set(
        samples.flatMap((sample) => sample.indicators ?? []),
    );
    const result = new Map<string, IndicatorPerformance>();

    for (const name of [...names].sort()) {
        const withIt = samples.filter((sample) =>
            sample.indicators?.includes(name),
        );
        const withoutIt = samples.filter(
            (sample) => !sample.indicators?.includes(name),
        );

        result.set(name, {
            metrics: computeMetrics(withIt, config),
            withIndicator: withIt.length,
            withoutIndicator: withoutIt.length,
        });
    }

    return result;
}

export interface CombinationValue {
    readonly metrics: Metrics;
    /** The same set of indicators, without the one being removed. */
    readonly lift: number | null;
}

/**
 * What each indicator adds on top of the others.
 *
 * `lift` is the difference in accuracy between signals where this indicator
 * was pointing the same way and signals where it was not, and it is null
 * whenever either side is below the sample floor. A lift computed from three
 * signals and a lift computed from three hundred are not the same number, and
 * reporting both as a number is how a table ends up recommending an indicator
 * on the strength of a coincidence.
 */
export function combinationValue(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
): ReadonlyMap<string, CombinationValue> {
    const names = new Set(
        samples.flatMap((sample) => sample.indicators ?? []),
    );
    const result = new Map<string, CombinationValue>();

    for (const name of [...names].sort()) {
        const withIt = samples.filter((sample) =>
            sample.indicators?.includes(name),
        );
        const withoutIt = samples.filter(
            (sample) => !sample.indicators?.includes(name),
        );

        const inside = computeMetrics(withIt, config);
        const outside = computeMetrics(withoutIt, config);

        result.set(name, {
            metrics: inside,
            lift:
                inside.accuracy === null || outside.accuracy === null
                    ? null
                    : inside.accuracy - outside.accuracy,
        });
    }

    return result;
}
