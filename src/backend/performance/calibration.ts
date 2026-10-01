import { computeMetrics, confidenceBuckets, groupBy } from './performance.js';
import { performanceConfig } from './performance.config.js';

import type { PerformanceConfig } from './performance.config.js';
import type { PerformanceSample } from './performance.js';

/**
 * Whether the confidence the system publishes describes how often it is right.
 *
 * This is the layer that lets the rest of the system be wrong in a checkable
 * way. Everything upstream produces a number between 0 and 100 and calls it
 * confidence; nothing upstream can say whether a 90 has ever been right nine
 * times in ten, and a number nobody has checked is a number nobody can act on.
 *
 * Calibration is the gap between what was claimed and what happened, computed
 * per bucket rather than as one average. A system that is right 60% of the time
 * on average can be perfectly calibrated or badly overconfident, and the
 * average cannot tell the two apart.
 */

export interface CalibrationPoint {
    /** Middle of the bucket, as a fraction. */
    readonly claimed: number;
    /** What actually happened, as a fraction. null below the sample floor. */
    readonly actual: number | null;
    readonly total: number;
    /**
     * Actual minus claimed.
     *
     * Positive means the system was too cautious, negative means it promised
     * more than it delivered. The sign is the whole content of this number, so
     * it is not clamped and not averaged away.
     */
    readonly gap: number | null;
}

export interface Calibration {
    readonly points: readonly CalibrationPoint[];
    /**
     * How well the numbers line up overall, 0..1, and null when there is not
     * enough measured to say.
     *
     * A weighted mean absolute gap. Weighted, because a bucket with two
     * signals should not move the score as much as one with two hundred, and
     * unweighted because the sign genuinely does not matter here — being too
     * confident in both directions is the same failure to a person deciding
     * whether to trust the number.
     */
    readonly score: number | null;
    /**
     * What the system tends to claim across the sample it has.
     *
     * Reported next to the score because "poorly calibrated" and "systematically
     * overconfident" are different diagnoses, and the fix for one is not the fix
     * for the other.
     */
    readonly meanClaimed: number | null;
    readonly meanActual: number | null;
    /** The worst single gap, so a single broken bucket cannot hide in a mean. */
    readonly worstGap: number | null;
    /** True when the sample could not support any of the above. */
    readonly unmeasured: boolean;
    /**
     * Which markets the numbers above are about.
     *
     * `null` when nothing was measured, otherwise every market in the sample,
     * sorted and comma-separated — so a calibration of two markets says so in the
     * report itself rather than leaving the question to whoever guesses.
     *
     * The bucket this report builds is keyed `'all'`, and that key used to be the
     * whole of what a reader knew about its reach: the score and the mean
     * claimed confidence were printed under a heading that never named a market.
     * Refusing a mixed sample is the wrong fix — PHASE 44 asks for a
     * portfolio-shaped aggregate eventually, and that is a fair question — so the
     * answer is made to name what it covers instead.
     */
    readonly scope: string | null;
}

/** Every market in a sample, named, sorted, and capped so it stays readable. */
export function describeScope(
    samples: readonly PerformanceSample[],
    limit = 4,
): string | null {
    const markets = [...new Set(samples.map((sample) => sample.symbol))].sort();

    if (markets.length === 0) return null;

    const named = markets.slice(0, limit);

    return markets.length > limit
        ? `${named.join(', ')} + ещё ${markets.length - limit}`
        : named.join(', ');
}

export const UNMEASURED: Calibration = {
    points: [],
    score: null,
    meanClaimed: null,
    meanActual: null,
    worstGap: null,
    scope: null,
    unmeasured: true,
};

/**
 * Builds the calibration curve.
 *
 * A bucket with no measured rate still produces a point, with `actual: null`
 * and `total` saying how many signals landed in it. The shape of the curve is
 * the finding, and dropping the empty buckets would draw a line straight
 * through the gaps and make an unmeasured range look like a good one.
 */
export function calibrate(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
): Calibration {
    if (samples.length === 0) {
        return UNMEASURED;
    }

    const { buckets } = confidenceBuckets(samples, config);

    const points: CalibrationPoint[] = buckets.map((bucket) => {
        const claimed = (bucket.from + bucket.to) / 2 / 100;
        const { accuracy, total } = bucket.metrics;

        return {
            claimed,
            actual: accuracy,
            total,
            gap: accuracy === null ? null : accuracy - claimed,
        };
    });

    const measured = points.filter(
        (point): point is CalibrationPoint & { actual: number; gap: number } =>
            point.actual !== null && point.gap !== null,
    );

    const allSamples = groupBy(samples, () => 'all', config).get('all');
    // Computed once, beside the bucket it describes. The bucket key is still
    // `'all'` — the label was never the problem, the label was the *only* thing
    // the reader had.
    const scope = describeScope(samples);

    if (measured.length === 0 || allSamples === undefined) {
        return {
            points,
            score: null,
            meanClaimed: allSamples?.accuracy ?? null,
            meanActual: null,
            worstGap: null,
            unmeasured: true,
            scope,
        };
    }

    const weight = measured.reduce((sum, point) => sum + point.total, 0);
    const score =
        measured.reduce(
            (sum, point) => sum + Math.abs(point.gap) * point.total,
            0,
        ) / weight;

    const meanClaimed =
        samples.reduce((sum, sample) => sum + sample.confidence, 0) /
        samples.length / 100;

    return {
        points,
        // Clamped rather than reported raw: a weighted mean absolute gap
        // between two rates in [0, 1] is in [0, 1] by construction, and a
        // score outside it means one of the two was not a rate.
        score: Math.min(1, Math.max(0, 1 - score)),
        meanClaimed,
        meanActual: allSamples.accuracy,
        scope,
        worstGap: measured.reduce(
            (worst, point) =>
                Math.abs(point.gap) > Math.abs(worst) ? point.gap : worst,
            measured[0]?.gap ?? 0,
        ),
        unmeasured: false,
    };
}

export interface Reliability {
    readonly score: number | null;
    /**
     * How the recent sample compares with the whole.
     *
     * Null when the recent window is too small to mean anything, which is a
     * different statement from "no change" and the one that is actually true
     * of a system with forty signals in its history.
     */
    readonly drift: number | null;
    readonly verdict:
        /** Not enough history to say anything. */
        | 'unmeasured'
        /** Recent and historical agree within the tolerance. */
        | 'stable'
        /** The recent sample is worse than the history by more than the tolerance. */
        | 'degrading'
        /** The recent sample is better. Reported, not celebrated. */
        | 'improving';
}

/**
 * The number that says whether the confidence can be trusted right now.
 *
 * Not the calibration score alone. A system that was perfectly calibrated over
 * two years and has quietly stopped being so scores well on history and is
 * useless today, and a reliability number is the only one that looks at what
 * happened lately.
 */
export function reliability(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
    options: {
        /** How many of the most recent signals count as "recent". */
        recent?: number;
        /**
         * How far the recent rate may sit from the historical one before it is
         * called drift.
         */
        tolerance?: number;
    } = {},
): Reliability {
    const recent = options.recent ?? 100;
    const tolerance = options.tolerance ?? 0.1;

    const all = calibrate(samples, config);

    if (all.score === null || samples.length < config.minimumSample) {
        return { score: null, drift: null, verdict: 'unmeasured' };
    }

    // The most recent samples, taken by time rather than by insertion order.
    // Order of arrival is an accident of how the poller ran, and a reliability
    // number built on it is a number about the poller.
    const ordered = [...samples].sort(
        (a, b) => b.timestamp - a.timestamp,
    );
    const window = new Set(ordered.slice(0, recent));

    const recentAccuracy = computeMetrics(
        ordered.filter((sample) => window.has(sample)),
        config,
    ).accuracy;

    if (recentAccuracy === null) {
        return { score: all.score, drift: null, verdict: 'unmeasured' };
    }

    // Measured against the rest of the history rather than against the overall
    // average, so a recent run that drags the average down cannot hide inside
    // the very number it is being compared to.
    const historical = computeMetrics(
        samples.filter((sample) => !window.has(sample)),
        config,
    ).accuracy;

    if (historical === null) {
        return { score: all.score, drift: null, verdict: 'unmeasured' };
    }

    const drift = recentAccuracy - historical;

    if (Math.abs(drift) <= tolerance) {
        return { score: all.score, drift, verdict: 'stable' };
    }

    return {
        score: all.score,
        drift,
        verdict: drift < 0 ? 'degrading' : 'improving',
    };
}
