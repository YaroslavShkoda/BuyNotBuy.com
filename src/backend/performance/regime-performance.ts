import type { PerformanceConfig } from './performance.config.js';
import { performanceConfig } from './performance.config.js';
import type { Metrics, PerformanceSample } from './performance.js';
import { computeMetrics, groupBy } from './performance.js';

/**
 * How the system behaves in each kind of market, rather than on average.
 *
 * An average across every regime is close to meaningless for a system like
 * this one, and the reason is structural: a trend detector and a signal
 * generator that only works in ranges are the same number in one table and
 * opposite facts in the market. Averaging them does not describe either.
 *
 * So this is a comparison, not a summary. A regime with no measured sample is
 * absent from the result rather than present with a null, and the spread
 * between the best and the worst regime is the finding — not the mean.
 */

export interface RegimePerformance {
    readonly metrics: Metrics;
    /**
     * How far this regime sits from the overall accuracy, as a fraction.
     *
     * null when either side is below the floor. A lift measured against an
     * unmeasured whole is a number about the regime, and it is exactly the
     * regime nobody is looking at.
     */
    readonly lift: number | null;
}

export interface RegimeBreakdown {
    readonly byRegime: ReadonlyMap<string, RegimePerformance>;
    /** The regime the system is best in, if the sample supports naming one. */
    readonly strongest: string | null;
    /** The regime it is worst in. */
    readonly weakest: string | null;
    /**
     * Best minus worst, or null when fewer than two regimes were measured.
     *
     * The headline figure. A system that is right eighty percent of the time
     * in one regime and wrong half the time in another is not a system with an
     * eighty percent track record, and this is the number that says so.
     */
    readonly spread: number | null;
    /**
     * How many samples carried no regime at all.
     *
     * Reported rather than dropped: a performance table built over sixty percent
     * of its own rows and presented as a whole is a table whose denominator is
     * not the one a reader assumes.
     */
    readonly unlabelled: number;
}

export function byRegime(
    samples: readonly PerformanceSample[],
    config: PerformanceConfig = performanceConfig,
): RegimeBreakdown {
    const overall = computeMetrics(samples, config);
    const groups = groupBy(samples, (sample) => sample.regime, config);

    const unlabelled = samples.filter(
        (sample) =>
            sample.regime === null ||
            sample.regime === undefined ||
            sample.regime === '',
    ).length;

    const byRegimeResult = new Map<string, RegimePerformance>();

    for (const [name, metrics] of groups) {
        byRegimeResult.set(name, {
            metrics,
            lift:
                metrics.accuracy === null || overall.accuracy === null
                    ? null
                    : metrics.accuracy - overall.accuracy,
        });
    }

    // Ranked by accuracy among the measured regimes only. Unmeasured buckets
    // are not in the map at all, so a null can never be ranked as if it were
    // a score.
    const measured = [...byRegimeResult]
        .filter(([, value]) => value.metrics.accuracy !== null)
        .sort(
            (a, b) =>
                (b[1].metrics.accuracy ?? 0) - (a[1].metrics.accuracy ?? 0),
        );

    const strongest = measured[0]?.[0] ?? null;
    const weakest = measured.at(-1)?.[0] ?? null;

    return {
        byRegime: byRegimeResult,
        strongest,
        weakest,
        spread:
            measured.length < 2
                ? null
                : (measured[0]?.[1].metrics.accuracy ?? 0) -
                  (measured.at(-1)?.[1].metrics.accuracy ?? 0),
        unlabelled,
    };
}
