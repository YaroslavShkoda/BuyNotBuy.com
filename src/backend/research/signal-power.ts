/**
 * Does a signal beat chance, or just beat the bars it skipped?
 *
 * Every result in this project up to now has been one number: the return of a
 * rule, or the return of the same rule with a piece removed. Both comparisons
 * are real and neither answers the question that matters, because both are
 * still inside the one series the signal was chosen on. A rule can beat its own
 * ablated self by a factor of twenty-four and beat a coin toss by nothing.
 *
 * That is not a hypothetical. On Binance BTCUSDT, 2096 daily bars from
 * 2021-01-01, the mean one-bar forward return:
 *
 *   bars the rule acted on      +0.1215%   (903 bars)
 *   bars the rule rejected      +0.0297%   (1136 bars)
 *   a random sample of the same size          +0.0701%
 *
 * The signal looks four times better than what it skipped, and a random sample
 * of the same size is in between. So which is it?
 *
 * The test: relabel the same bars at random, keeping both group sizes, and ask
 * how often a relabelling produces a difference at least as large as the
 * observed one. `p` is the fraction of the time the observed gap could have
 * come from noise alone.
 *
 *   volatility-trend, BTCUSDT     p = 0.4908
 *   volatility-trend, ETHUSDT     p = 0.4870
 *   donchian-20,      BTCUSDT     p = 0.6198
 *   donchian-20,      ETHUSDT     p = 0.2670
 *
 * A coin flip scores 0.49 about half the time. All four did. The filter that
 * appeared to be carrying the entire strategy, and the breakout it appeared to
 * be carrying it past, are both indistinguishable from a random choice of
 * bars — on two assets, with the drift held constant inside the comparison,
 * which is the one thing that comparison controls for.
 *
 * **The +222.99% is not refuted, it is explained.** The rule was long 44% of
 * the time in an asset that rose 83% over the same span. Compounding the mean
 * forward return of its own signal bars over all 903 of them gives +199.49%,
 * close enough to the backtest figure to confirm the mechanism: it was the
 * drift, collected on a schedule the volatility filter chose, and the filter's
 * own contribution to that schedule is not separable from chance.
 *
 * ## What this module will not do
 *
 * It reports a p-value, and a p-value is not a verdict. `p = 0.49` on a rule
 * that made money says the evidence is too weak to distinguish the rule from
 * luck, not that the rule definitely is luck — the difference is what the
 * held-out window exists for. The direction of the mistake matters: reading
 * "no evidence" as "no edge" would throw away the only honest next step,
 * which is to go and collect more bars.
 */

/** A bar, reduced to what a one-bar-forward measurement needs. */
export interface SeriesPoint {
    readonly close: number;
}

export interface PermutationResult {
    /** Fraction of relabellings at least as extreme as the observed one. */
    readonly p: number;
    /** Mean of the values the signal fired on. */
    readonly onMean: number;
    /** Mean of the values the signal skipped. */
    readonly offMean: number;
    /** `onMean - offMean`, the thing being tested. */
    readonly difference: number;
    readonly onCount: number;
    readonly offCount: number;
    readonly draws: number;
}

export interface PermutationOptions {
    /** Relabellings. Enough that the p-value means something at its own resolution. */
    readonly draws?: number;
    /**
     * Seed for the relabelling.
     *
     * Fixed by default because a p-value that changes between two runs of the
     * same command cannot be compared with a p-value from the previous run, and
     * the whole use of this module is comparison. Reported in the output so a
     * number can be reproduced.
     */
    readonly seed?: number;
}

const DEFAULT_DRAWS = 5000;
const DEFAULT_SEED = 0x5eed_1a7e;

/**
 * The null distribution: the same bars, split at random, same group sizes.
 *
 * The split is a Fisher–Yates shuffle of every index, with the first `onCount`
 * taken as the fired group. Sorting the indices instead of shuffling them would
 * partition the series into a prefix and a suffix and measure nothing but
 * whether the asset went up, which is a bug this file was written after
 * making: an earlier version relabelled with `i < onCount` and produced exactly
 * two partitions, and p-values of precisely 1.0000 and 0.0000.
 */
export function permutationPValue(
    values: readonly number[],
    signal: readonly boolean[],
    options: PermutationOptions = {},
): PermutationResult {
    if (values.length !== signal.length) {
        throw new Error(
            `values and signal must be the same length: got ${values.length} and ${signal.length}`,
        );
    }

    if (values.length === 0) {
        throw new Error('permutationPValue needs at least one value');
    }

    const draws = options.draws ?? DEFAULT_DRAWS;
    const seed = options.seed ?? DEFAULT_SEED;
    const random = mulberry32(seed);

    // One pass, keeping the pooled values and the two groups together. Bars
    // without a forward return drop out of all three at once, so the group
    // sizes the shuffle draws from are the sizes that were measured.
    const pool: number[] = [];
    const on: number[] = [];
    const off: number[] = [];

    for (let index = 0; index < values.length; index += 1) {
        const value = values[index]!;

        if (!Number.isFinite(value)) {
            continue;
        }

        pool.push(value);

        if (signal[index] === true) {
            on.push(value);
        } else {
            off.push(value);
        }
    }

    const onCount = on.length;

    if (onCount === 0 || off.length === 0) {
        throw new Error(
            'permutationPValue needs a signal that fires on some bars and not on others: ' +
                `got ${onCount} on and ${off.length} off`,
        );
    }

    const onMean = mean(on);
    const offMean = mean(off);
    const difference = onMean - offMean;

    const index = pool.map((_, position) => position);
    let atLeastAsExtreme = 0;

    for (let draw = 0; draw < draws; draw += 1) {
        shuffleInPlace(index, random);

        let onSum = 0;
        let offSum = 0;

        for (let position = 0; position < onCount; position += 1) {
            onSum += pool[index[position]!]!;
        }

        for (let position = onCount; position < index.length; position += 1) {
            offSum += pool[index[position]!]!;
        }

        const shuffled =
            onSum / onCount - offSum / (index.length - onCount);

        if (Math.abs(shuffled) >= Math.abs(difference)) {
            atLeastAsExtreme += 1;
        }
    }

    return {
        // Plus one in numerator and denominator: a p-value of exactly zero is
        // not a measurement, it is the absence of one, and the control below
        // is the thing that has to be able to produce it.
        p: (atLeastAsExtreme + 1) / (draws + 1),
        onMean,
        offMean,
        difference,
        onCount,
        offCount: off.length,
        draws,
    };
}

/**
 * One-bar forward return at every index.
 *
 * The last two bars have no forward bar and are `NaN`, which the callers leave
 * to be excluded rather than filling with zero — a zero forward return would
 * quietly pull every mean down and make a weak signal look weaker.
 */
export function forwardReturns(closes: readonly number[], bars = 1): number[] {
    return closes.map((close, index) => {
        const future = closes[index + bars];

        return future === undefined || close <= 0 ? Number.NaN : future / close - 1;
    });
}

/**
 * A signal that is the answer, used to prove the test can see anything.
 *
 * Not a strategy. A check on the instrument: fire on every bar where the next
 * bar went up, and the test must report a p-value at its floor. A permutation
 * test that cannot reject a signal made of the future is not measuring
 * anything, and the p = 0.49s above would have been indistinguishable from a
 * test stuck at 0.5.
 */
export function futureSignal(forward: readonly number[]): boolean[] {
    return forward.map((value) => Number.isFinite(value) && value > 0);
}

/**
 * A deterministic generator, so two runs of the same command agree.
 *
 * `Math.random` is not available to a test that needs to assert a specific
 * p-value, and a research command that reports a different number each time it
 * is run is a command whose output cannot be compared with anything, including
 * its own previous output.
 */
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function shuffleInPlace(items: number[], random: () => number): void {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const held = items[i]!;
        items[i] = items[j]!;
        items[j] = held;
    }
}

function mean(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0) / values.length;
}
