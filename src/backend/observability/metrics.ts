import { z } from 'zod';

/**
 * The numbers worth watching, kept in memory.
 *
 * A latency *average* is close to useless for deciding whether anything is
 * wrong: a hundred fast requests and one that took thirty seconds average to
 * something nobody would page about, and the one that took thirty seconds is
 * the request somebody is sitting in front of. So every duration is kept as a
 * bounded reservoir of samples and the percentile is computed from those, and
 * the maximum is kept exactly because it is the thing that is unbounded.
 *
 * The reservoir is bounded and that is the trade. It costs a fixed amount of
 * memory forever, it loses the exact shape of the tail, and in exchange it
 * cannot be made to grow by a caller. A percentile computed from the last 2000
 * samples answers "how bad is it lately", which is the question a dashboard
 * asks; a histogram that grows without bound answers "how bad was it once",
 * and nobody is on call for a question about last March.
 */

export const MetricConfigSchema = z
    .object({
        /** Samples kept per duration metric. */
        reservoir: z.coerce.number().int().min(10).max(100_000),
        /**
         * How many leading values are kept exactly.
         *
         * The first few hundred requests after a deploy are the ones nobody
         * has seen before, and they are the ones a plain reservoir of 2000
         * would represent worst. Keeping them exactly costs a fixed number of
         * slots and means the first report after a cold start is not a summary
         * of nothing.
         */
        warmup: z.coerce.number().int().min(0).max(100_000),
    })
    .refine((config) => config.warmup < config.reservoir, {
        message: 'A warm-up longer than the reservoir would leave no room for it',
        path: ['warmup'],
    });

export type MetricConfig = z.infer<typeof MetricConfigSchema>;

export const DEFAULT_METRIC_CONFIG: MetricConfig = MetricConfigSchema.parse({
    reservoir: 2000,
    warmup: 256,
});

/** A bounded sample that keeps the most recent values plus the first ones. */
export class Reservoir {
    readonly #capacity: number;
    readonly #warmup: number;
    #warm: number[] = [];
    #recent: number[] = [];
    #seen = 0;
    #max = Number.NEGATIVE_INFINITY;
    #sum = 0;

    constructor(config: MetricConfig = DEFAULT_METRIC_CONFIG) {
        this.#capacity = config.reservoir;
        this.#warmup = config.warmup;
    }

    record(value: number): void {
        if (!Number.isFinite(value)) {
            // A NaN reaching a percentile makes every percentile NaN, and a
            // dashboard of NaN is worse than a dashboard with a gap in it.
            return;
        }

        this.#seen += 1;
        this.#sum += value;
        this.#max = Math.max(this.#max, value);

        if (this.#warm.length < this.#warmup) {
            this.#warm.push(value);
            return;
        }

        this.#recent.push(value);

        if (this.#recent.length > this.#capacity) {
            this.#recent.shift();
        }
    }

    get seen(): number {
        return this.#seen;
    }

    get max(): number {
        return this.#seen === 0 ? 0 : this.#max;
    }

    get mean(): number {
        return this.#seen === 0 ? 0 : this.#sum / this.#seen;
    }

    /**
     * The total of everything ever recorded, not of what is still in the window.
     *
     * The reservoir deliberately forgets samples so it cannot be made to grow,
     * but a `_sum` that forgot with it would make the rate of a metric a
     * function of how much had been written since the last thousand samples,
     * which is a number that changes meaning while the system runs.
     */
    get sum(): number {
        return this.#sum;
    }

    /**
     * The percentile, from whatever samples exist.
     *
     * Nearest-rank rather than interpolated: a p99 is the value a request
     * actually took, not a value between two of them, and interpolating
     * invents a latency that never occurred.
     */
    percentile(fraction: number): number {
        const values = this.samples();

        if (values.length === 0) {
            return 0;
        }

        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(fraction * sorted.length) - 1),
        );

        return sorted[index] ?? 0;
    }

    samples(): number[] {
        return [...this.#warm, ...this.#recent];
    }

    get bounded(): boolean {
        return this.samples().length <= this.#capacity + this.#warmup;
    }
}

interface DurationSnapshot {
    readonly name: string;
    readonly seen: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
}

export interface Counters {
    started: number;
    succeeded: number;
    failed: number;
    /** Failed, and we know which stage. */
    byStage: Record<string, number>;
}

export interface MetricsSnapshot {
    readonly durations: readonly DurationSnapshot[];
    readonly counters: Counters;
    readonly takenAt: number;
}

/**
 * The registry every part of the system reports to.
 *
 * `duration` and `count` are separate calls on purpose. A timer that is
 * started and never stopped — because the code between threw — leaves no trace
 * at all in a design where stopping is the reporting, and a missing metric is
 * indistinguishable from a fast one.
 */
export function createMetrics(config: MetricConfig = DEFAULT_METRIC_CONFIG) {
    const durations = new Map<string, Reservoir>();
    const counters: Counters = { started: 0, succeeded: 0, failed: 0, byStage: {} };

    return {
        duration(name: string, value: number): void {
            let reservoir = durations.get(name);

            if (reservoir === undefined) {
                reservoir = new Reservoir(config);
                durations.set(name, reservoir);
            }

            reservoir.record(value);
        },

        /** Times a block and returns its result whatever happens inside. */
        time<T>(name: string, work: () => T): T {
            const startedAt = performance.now();

            try {
                return work();
            } finally {
                // A finally, not an after: a duration that is only recorded on
                // the happy path describes how fast success is, which is the
                // one thing nobody is paged about.
                this.duration(name, performance.now() - startedAt);
            }
        },

        started(): void {
            counters.started += 1;
        },

        succeeded(): void {
            counters.succeeded += 1;
        },

        failed(stage: string): void {
            counters.failed += 1;
            counters.byStage[stage] = (counters.byStage[stage] ?? 0) + 1;
        },

        snapshot(takenAt: number): MetricsSnapshot {
            return {
                durations: [...durations.entries()].map(([name, reservoir]) => ({
                    name,
                    seen: reservoir.seen,
                    mean: reservoir.mean,
                    p50: reservoir.percentile(0.5),
                    p95: reservoir.percentile(0.95),
                    p99: reservoir.percentile(0.99),
                    max: reservoir.max,
                })),
                counters: {
                    ...counters,
                    byStage: { ...counters.byStage },
                },
                takenAt,
            };
        },

        get series(): Map<string, Reservoir> {
            return durations;
        },
    };
}

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * The metric names this project promised to publish.
 *
 * Written down as a list with the three kinds separated, because the three
 * kinds are not interchangeable and a registry that treats them as one number
 * is where monitoring goes wrong:
 *
 *  - a counter only goes up, and a counter that can go down has lost the one
 *    property that makes it a counter — the ability to tell "twice as many
 *    errors this hour" from "the same errors, counted differently";
 *  - a gauge goes both ways, and a gauge that only goes up is a counter with a
 *    misleading name (`provider_circuit_open` is 1 or 0, never 2);
 *  - a distribution summarises a shape. `provider_latency` with one number on it
 *    is the average, and the average is exactly the number that hides the
 *    request somebody is sitting in front of.
 *
 * The list is closed on purpose. A metric added later still has to be declared
 * here, which means the exposition can be diffed against the promise, and a
 * test does the diffing.
 */
export const METRIC_COUNTERS = [
    'provider_requests_total',
    'provider_errors_total',
    'provider_rate_limits',
    'market_cache_hits',
    'market_cache_misses',
    'market_stale_served',
    'signal_generation_total',
    'signal_changes_total',
    'strategy_decision_write_failures',
    'market_cycle_failures',
    'provider_retries',
    // Declared in round 107. These were being exposed by hand from
    // `api/lib/metrics.ts` and were in neither list, so nothing could say what
    // kind they were or check that the exposition agreed with anything.
    'write_backlog_signal_history_dropped_total',
    'write_backlog_indicator_vote_dropped_total',
    'write_backlog_strategy_decision_dropped_total',
] as const;

export const METRIC_GAUGES = [
    'provider_circuit_open',
    'provider_error_rate',
    'provider_health',
    'provider_consecutive_failures',
    'metric_series_limit',
    'write_backlog_signal_history_buffered',
    'write_backlog_indicator_vote_buffered',
    'write_backlog_strategy_decision_buffered',
    'write_backlog_signal_history_spooled',
    'write_backlog_indicator_vote_spooled',
    'write_backlog_strategy_decision_spooled',
] as const;

export const METRIC_DISTRIBUTIONS = [
    'provider_latency',
    'indicator_calculation_duration',
    'database_query_duration',
    'backtest_duration',
] as const;

export const METRIC_NAMES = [
    ...METRIC_COUNTERS,
    ...METRIC_GAUGES,
    ...METRIC_DISTRIBUTIONS,
] as const;

type MetricName = (typeof METRIC_NAMES)[number];

const MetricKindSchema = z.enum(['counter', 'gauge', 'distribution']);
type MetricKind = z.infer<typeof MetricKindSchema>;

export const METRIC_KIND: Readonly<Record<MetricName, MetricKind>> = {
    provider_retries: 'counter',
    provider_error_rate: 'gauge',
    provider_health: 'gauge',
    provider_consecutive_failures: 'gauge',
    metric_series_limit: 'gauge',
    provider_requests_total: 'counter',
    provider_errors_total: 'counter',
    provider_rate_limits: 'counter',
    market_cache_hits: 'counter',
    market_cache_misses: 'counter',
    market_stale_served: 'counter',
    signal_generation_total: 'counter',
    signal_changes_total: 'counter',
    strategy_decision_write_failures: 'counter',
    market_cycle_failures: 'counter',
    provider_circuit_open: 'gauge',
    provider_latency: 'distribution',
    indicator_calculation_duration: 'distribution',
    database_query_duration: 'distribution',
    backtest_duration: 'distribution',
    write_backlog_signal_history_buffered: 'gauge',
    write_backlog_signal_history_dropped_total: 'counter',
    write_backlog_indicator_vote_buffered: 'gauge',
    write_backlog_indicator_vote_dropped_total: 'counter',
    write_backlog_strategy_decision_buffered: 'gauge',
    write_backlog_strategy_decision_dropped_total: 'counter',
    write_backlog_signal_history_spooled: 'gauge',
    write_backlog_indicator_vote_spooled: 'gauge',
    write_backlog_strategy_decision_spooled: 'gauge',
};

export function metricKind(name: string): MetricKind | null {
    return Object.hasOwn(METRIC_KIND, name)
        ? METRIC_KIND[name as MetricName]
        : null;
}

/**
 * Whether a snapshot is worth waking somebody for.
 *
 * Deliberately conservative, and deliberately not derived from the average. A
 * rule that fires on a mean is a rule that fires on volume; a rule that fires
 * on p99 and on the failure ratio is a rule that fires on the experience.
 */
export interface AlertVerdict {
    readonly fires: boolean;
    readonly reasons: readonly string[];
}

export function judgeSnapshot(
    snapshot: MetricsSnapshot,
    thresholds: { p99Ms?: number; failureRatio?: number; minSample?: number } = {},
): AlertVerdict {
    const p99Limit = thresholds.p99Ms ?? 5_000;
    const failureLimit = thresholds.failureRatio ?? 0.05;
    const minSample = thresholds.minSample ?? 20;
    const reasons: string[] = [];

    for (const duration of snapshot.durations) {
        if (duration.seen < minSample) {
            // No sample is not a good sample. A rule that fires on two
            // requests pages somebody about a cold start.
            continue;
        }

        if (duration.p99 > p99Limit) {
            reasons.push(
                `${duration.name}: p99 ${Math.round(duration.p99)}ms при пороге ${p99Limit}ms (n=${duration.seen})`,
            );
        }
    }

    const finished = snapshot.counters.succeeded + snapshot.counters.failed;

    if (finished >= minSample) {
        const ratio = snapshot.counters.failed / finished;

        if (ratio > failureLimit) {
            reasons.push(
                `доля отказов ${(ratio * 100).toFixed(1)}% при пороге ${(failureLimit * 100).toFixed(1)}% (n=${finished})`,
            );
        }
    }

    return { fires: reasons.length > 0, reasons };
}
