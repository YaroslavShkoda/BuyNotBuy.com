import { z } from 'zod';

/**
 * How much of a result is luck, and how the code finds out.
 *
 * Three questions, three tools, and the point of all three is the same: a
 * backtest figure describes the sample it was measured on, and the sample is
 * one draw. Bootstrap asks what the same strategy would have produced on other
 * samples of the same size. Permutation asks what an equally good-looking
 * result would appear from a strategy with no edge at all. Monte Carlo asks
 * what the path would have looked like if the trades had arrived in some other
 * order — which is the thing an equity curve is actually a sample of.
 *
 * Every one of them is deterministic given its seed. A randomised check that
 * cannot be re-run is a check that cannot be argued with, and the whole reason
 * to run it is to argue.
 *
 * The seed is passed in rather than drawn, and there is no `Math.random()`
 * anywhere in this module. That is not fastidiousness: a result that changes
 * between two runs of the same test will be reported as a flake, then
 * ignored, and the third time it is a real finding it will be ignored too.
 */

export const StatisticsConfigSchema = z.object({
    resamples: z.coerce.number().int().positive().max(100_000),
    permutations: z.coerce.number().int().positive().max(100_000),
    monteCarloRuns: z.coerce.number().int().positive().max(100_000),
    /**
     * Two-tailed significance below which a result is called significant.
     *
     * Five percent is the conventional number and the conventional number is
     * not a particularly good one: on a market this system can look at a few
     * hundred parameter sets, five percent of them will look significant by
     * accident, which is the entire reason the neighbourhood check in the
     * optimiser exists. The value is configurable because the right threshold
     * depends on how many things were tried, and the caller is the only one
     * that knows.
     */
    significance: z.coerce.number().min(0).max(1),
});

export type StatisticsConfig = z.infer<typeof StatisticsConfigSchema>;

export const DEFAULT_STATISTICS_CONFIG: StatisticsConfig =
    StatisticsConfigSchema.parse({
        resamples: 2000,
        permutations: 1000,
        monteCarloRuns: 2000,
        significance: 0.05,
    });

/**
 * A small, explicit PRNG.
 *
 * Mulberry32: four lines, no state beyond one 32-bit integer, and the same
 * seed always produces the same sequence on every platform. `Math.random` is
 * not acceptable here for the reason above, and a library is not either,
 * because a dependency whose version changes would silently change every
 * number this system has ever published.
 */
export function createRandom(seed: number): () => number {
    let state = Math.trunc(seed) >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface Interval {
    readonly low: number;
    readonly high: number;
    /** Share of resamples below zero. The one-sided reading of a confidence. */
    readonly belowZero: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
    if (sorted.length === 0) {
        return Number.NaN;
    }

    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    if (lower === upper) {
        return sorted[lower] ?? Number.NaN;
    }

    const weight = position - lower;

    return (
        (sorted[lower] ?? Number.NaN) * (1 - weight) +
        (sorted[upper] ?? Number.NaN) * weight
    );
}

export interface BootstrapResult {
    readonly statistic: number;
    readonly interval: Interval;
    readonly resamples: number;
    readonly seed: number;
}

/**
 * Resamples the trade list with replacement.
 *
 * Trades are the unit, not bars. A bar-level bootstrap would destroy the
 * clustering — five losing bars in a row are one piece of information, not
 * five — and would answer a question about bars that nobody asked.
 */
export function bootstrapStatistic(
    trades: readonly { readonly netReturn: number }[],
    statistic: (returns: readonly number[]) => number,
    config: StatisticsConfig = DEFAULT_STATISTICS_CONFIG,
    seed = 1,
): BootstrapResult | null {
    if (trades.length === 0) {
        return null;
    }

    const random = createRandom(seed);
    const values = trades.map((trade) => trade.netReturn);
    const samples: number[] = [];

    for (let run = 0; run < config.resamples; run += 1) {
        const draw = new Array<number>(values.length);

        for (let index = 0; index < values.length; index += 1) {
            draw[index] = values[Math.floor(random() * values.length)] ?? 0;
        }

        samples.push(statistic(draw));
    }

    samples.sort((a, b) => a - b);
    const alpha = config.significance;

    return {
        statistic: statistic(values),
        interval: {
            low: percentile(samples, alpha / 2),
            high: percentile(samples, 1 - alpha / 2),
            belowZero:
                samples.filter((value) => value < 0).length / samples.length,
        },
        resamples: config.resamples,
        seed,
    };
}

export interface PermutationResult {
    /** Share of null samples at or above the observed statistic. */
    readonly pValue: number;
    readonly significant: boolean;
    readonly observed: number;
    readonly permutations: number;
    readonly seed: number;
}

/**
 * The null distribution: the same trades with their order destroyed.
 *
 * This is the test a bootstrap cannot do. Bootstrap asks "would another sample
 * of the market have given this", which still assumes the trades were chosen
 * for a reason. Permutation asks "what would this look like if they were
 * chosen by a coin", which is the question that actually tests whether the
 * selection carried information.
 */
export function permutationTest(
    trades: readonly { readonly netReturn: number }[],
    statistic: (returns: readonly number[]) => number,
    config: StatisticsConfig = DEFAULT_STATISTICS_CONFIG,
    seed = 1,
): PermutationResult | null {
    if (trades.length === 0) {
        return null;
    }

    const random = createRandom(seed);
    const values = trades.map((trade) => trade.netReturn);
    const observed = statistic(values);
    const shuffled = [...values];

    let atLeastAsExtreme = 0;

    for (let run = 0; run < config.permutations; run += 1) {
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(random() * (index + 1));
            const held = shuffled[index]!;

            shuffled[index] = shuffled[swap]!;
            shuffled[swap] = held;
        }

        if (statistic(shuffled) >= observed) {
            atLeastAsExtreme += 1;
        }
    }

    // Plus one in numerator and denominator. Without it, zero extreme
    // permutations reports a p-value of exactly zero, which reads as
    // "impossible" rather than "not observed in a thousand tries" — and the
    // second is the true statement.
    const pValue = (atLeastAsExtreme + 1) / (config.permutations + 1);

    return {
        pValue,
        significant: pValue < config.significance,
        observed,
        permutations: config.permutations,
        seed,
    };
}

export interface PathResult {
    readonly finalReturn: number;
    readonly maxDrawdown: number;
    /** Longest run of consecutive losing trades, in trades. */
    readonly worstStreak: number;
    /** Longest run without reaching a new peak, in trades. */
    readonly worstDrawdownRun: number;
}

export function pathOf(returns: readonly number[]): PathResult {
    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    let losing = 0;
    let worstStreak = 0;
    let underWater = 0;
    let worstDrawdownRun = 0;

    for (const value of returns) {
        equity *= 1 + value;
        peak = Math.max(peak, equity);

        const drawdown = 1 - equity / peak;

        maxDrawdown = Math.max(maxDrawdown, drawdown);

        if (value < 0) {
            losing += 1;
            worstStreak = Math.max(worstStreak, losing);
        } else {
            losing = 0;
        }

        if (drawdown > 0) {
            underWater += 1;
            worstDrawdownRun = Math.max(worstDrawdownRun, underWater);
        } else {
            underWater = 0;
        }
    }

    return {
        finalReturn: equity - 1,
        maxDrawdown,
        worstStreak,
        worstDrawdownRun,
    };
}

export interface MonteCarloResult {
    readonly median: PathResult;
    /** Every outcome, sorted by final return. */
    readonly outcomes: readonly PathResult[];
    readonly observed: PathResult;
    /**
     * Share of reshuffled paths that ended worse than the real one.
     *
     * The one number a reader should take away: it is the probability that the
     * order the strategy actually produced was luckier than a random one. Near
     * one means the order was carrying the result and the return says nothing
     * about the edge.
     */
    readonly orderIsLuck: number;
    readonly runs: number;
    readonly seed: number;
}

/**
 * The same trades in a different order.
 *
 * The final return is identical every time — multiplying the same numbers in a
 * different order gives the same product — which is exactly the point. What
 * changes is the path, and the path is what a person experiences. Two
 * strategies with identical expectancies can differ by a factor of ten in the
 * drawdown a holder has to sit through, and only this finds it.
 */
export function monteCarlo(
    trades: readonly { readonly netReturn: number }[],
    config: StatisticsConfig = DEFAULT_STATISTICS_CONFIG,
    seed = 1,
): MonteCarloResult | null {
    if (trades.length === 0) {
        return null;
    }

    const random = createRandom(seed);
    const values = trades.map((trade) => trade.netReturn);
    const observed = pathOf(values);
    const shuffled = [...values];
    const outcomes: PathResult[] = [];

    for (let run = 0; run < config.monteCarloRuns; run += 1) {
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(random() * (index + 1));
            const held = shuffled[index]!;

            shuffled[index] = shuffled[swap]!;
            shuffled[swap] = held;
        }

        outcomes.push(pathOf(shuffled));
    }

    outcomes.sort((a, b) => a.finalReturn - b.finalReturn);
    const median = outcomes[Math.floor(outcomes.length / 2)] ?? observed;
    const worse = outcomes.filter(
        (outcome) => outcome.finalReturn < observed.finalReturn,
    ).length;

    return {
        median,
        outcomes,
        observed,
        orderIsLuck: worse / outcomes.length,
        runs: config.monteCarloRuns,
        seed,
    };
}

/** Total return of a sequence, the statistic the other two are compared to. */
export function totalReturn(returns: readonly number[]): number {
    return returns.reduce((product, value) => product * (1 + value), 1) - 1;
}
