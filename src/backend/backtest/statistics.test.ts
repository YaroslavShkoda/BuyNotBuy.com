import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StatisticsConfig } from './statistics.js';
import {
    bootstrapStatistic,
    createRandom,
    DEFAULT_STATISTICS_CONFIG,
    monteCarlo,
    pathOf,
    permutationTest,
    StatisticsConfigSchema,
    totalReturn,
} from './statistics.js';

const FAST: StatisticsConfig = StatisticsConfigSchema.parse({
    resamples: 300,
    permutations: 300,
    monteCarloRuns: 300,
    significance: 0.05,
});

function trades(returns: number[]): { netReturn: number }[] {
    return returns.map((netReturn) => ({ netReturn }));
}

describe('the same seed always gives the same answer', () => {
    it('repeats a sequence exactly', () => {
        const first = createRandom(42);
        const second = createRandom(42);

        expect(Array.from({ length: 20 }, first)).toEqual(
            Array.from({ length: 20 }, second),
        );
    });

    it('does not repeat for a different seed', () => {
        const first = Array.from({ length: 20 }, createRandom(1));
        const second = Array.from({ length: 20 }, createRandom(2));

        expect(first).not.toEqual(second);
    });

    it('gives a test the same number twice', () => {
        // A randomised check that cannot be re-run is a check that cannot be
        // argued with, and the reason to run it is to argue.
        const sample = trades([0.1, -0.05, 0.02, 0.08, -0.01]);

        expect(bootstrapStatistic(sample, totalReturn, FAST, 7)).toEqual(
            bootstrapStatistic(sample, totalReturn, FAST, 7),
        );
        expect(monteCarlo(sample, FAST, 7)!.orderIsLuck).toBe(
            monteCarlo(sample, FAST, 7)!.orderIsLuck,
        );
    });

    it('stays inside the unit interval, whatever the seed', () => {
        fc.assert(
            fc.property(fc.integer(), (seed) => {
                const random = createRandom(seed);
                let value = 0;

                for (let draw = 0; draw < 50; draw += 1) {
                    value = random();
                    expect(value).toBeGreaterThanOrEqual(0);
                    expect(value).toBeLessThan(1);
                }
            }),
            { numRuns: 50 },
        );
    });
});

describe('bootstrap asks about other samples of the same trades', () => {
    it('brackets the observed statistic', () => {
        // 40 winning trades and 3 losers: the interval should sit above zero,
        // because it would be extraordinary for this set of trades to be
        // unrepresentative of itself.
        const sample = trades([
            ...Array.from({ length: 40 }, () => 0.02),
            -0.05,
            -0.03,
            -0.01,
        ]);
        const result = bootstrapStatistic(sample, totalReturn, FAST, 3)!;

        expect(result.interval.low).toBeGreaterThan(0);
        expect(result.interval.belowZero).toBe(0);
    });

    it('spans zero when the trades are a coin flip', () => {
        // 50 wins and 50 losses of the same size: a resample of that is as
        // likely to come out behind as ahead, and an interval that stayed
        // clear of zero would be the interval lying.
        const sample = trades([
            ...Array.from({ length: 50 }, () => 0.01),
            ...Array.from({ length: 50 }, () => -0.01),
        ]);
        const result = bootstrapStatistic(sample, totalReturn, FAST, 3)!;

        expect(result.interval.low).toBeLessThan(0);
        expect(result.interval.high).toBeGreaterThan(0);
    });

    it('reports nothing rather than a confident answer about no trades', () => {
        expect(bootstrapStatistic([], totalReturn, FAST, 1)).toBeNull();
    });

    it('refuses a resample count that would take all afternoon', () => {
        expect(() =>
            StatisticsConfigSchema.parse({
                resamples: 1_000_000,
                permutations: 10,
                monteCarloRuns: 10,
                significance: 0.05,
            }),
        ).toThrow();
    });
});

describe('permutation asks what luck would have looked like', () => {
    /**
     * The longest run of consecutive winning trades.
     *
     * Chosen because it is the only kind of statistic a permutation test can
     * use. The test shuffles the returns, and the total return of a sequence
     * is a product — commutative, identical under every shuffle. A first
     * version of this file passed `totalReturn` and asked for significance, and
     * it failed: the observed value never moved, so the p-value was 1.0 for a
     * set of trades that is about as one-sided as a set can be. Bootstrapping
     * and permuting are different questions, and only one of them is about the
     * endpoint.
     */
    const longestWinRun = (returns: readonly number[]): number => {
        let best = 0;
        let current = 0;

        for (const value of returns) {
            current = value > 0 ? current + 1 : 0;
            best = Math.max(best, current);
        }

        return best;
    };

    it('calls a real edge significant', () => {
        // Large and one-sided: shuffling cannot manufacture a set of trades
        // that wins 40 times out of 43.
        const sample = trades([
            ...Array.from({ length: 40 }, () => 0.02),
            -0.05,
            -0.03,
            -0.01,
        ]);
        const result = permutationTest(sample, longestWinRun, FAST, 5)!;

        expect(result.significant).toBe(true);
        expect(result.pValue).toBeLessThan(0.05);
    });

    it('does not call a coin flip significant', () => {
        // Alternating, not fifty wins then fifty losses. A fixture with all
        // the wins consecutive has a run of fifty in it, and the test then
        // reports that a run of fifty is unlikely — correctly, and about the
        // fixture rather than about a coin flip.
        const sample = trades(
            Array.from({ length: 100 }, (_, index) =>
                index % 2 === 0 ? 0.01 : -0.01,
            ),
        );
        const result = permutationTest(sample, longestWinRun, FAST, 5)!;

        expect(result.significant).toBe(false);
    });

    it('refuses to be fooled by a statistic the shuffle cannot move', () => {
        // The bug this section was written because of, pinned so it cannot
        // come back as an innocent-looking change of statistic.
        const sample = trades([
            ...Array.from({ length: 40 }, () => 0.02),
            -0.05,
            -0.03,
            -0.01,
        ]);
        const result = permutationTest(sample, totalReturn, FAST, 5)!;

        // Total return is a product, so every shuffle gives essentially the
        // same answer and nothing is significant. "Essentially", not "exactly":
        // floating point multiplication is not associative, so a product
        // reordered differs in the last bits and roughly half the shuffles
        // land a hair above. That is why the assertion is about the verdict
        // rather than about a p-value of exactly one — which is also the
        // honest number, because zero extreme permutations reporting 0.0 is
        // the thing the +1 correction exists to prevent.
        expect(result.observed).toBeCloseTo(
            totalReturn(sample.map((t) => t.netReturn)),
            10,
        );
        expect(result.significant).toBe(false);
        expect(result.pValue).toBeGreaterThan(0.5);
    });

    it('never reports a p-value of exactly zero', () => {
        // Zero reads as "impossible". The true statement is "not observed in a
        // thousand tries", and a reader acting on the difference would act on
        // the wrong one.
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 100 }), (seed) => {
                const sample = trades(
                    Array.from({ length: 30 }, () => 0.05),
                );
                const result = permutationTest(sample, totalReturn, FAST, seed)!;

                expect(result.pValue).toBeGreaterThan(0);
                expect(result.pValue).toBeGreaterThanOrEqual(1 / (FAST.permutations + 1));
            }),
            { numRuns: 20 },
        );
    });
});

describe('monte carlo is about the path, not the endpoint', () => {
    it('keeps the endpoint and moves the path', () => {
        // Multiplying the same numbers in a different order gives the same
        // product. That is the point: what changes is what a holder sits
        // through, and only this finds it.
        const sample = trades([0.5, -0.5, 0.5, -0.5, 0.02]);

        expect(pathOf(sample.map((trade) => trade.netReturn)).finalReturn).toBeCloseTo(
            totalReturn(sample.map((trade) => trade.netReturn)),
            10,
        );

        const result = monteCarlo(sample, FAST, 11)!;
        const drawdowns = result.outcomes.map((outcome) => outcome.maxDrawdown);

        expect(Math.max(...drawdowns)).toBeGreaterThan(
            Math.min(...drawdowns),
        );
    });

    it('reports the longest run of losses the trades actually had', () => {
        const result = pathOf([0.1, -0.01, -0.02, -0.03, 0.05, -0.01, -0.01]);

        expect(result.worstStreak).toBe(3);
    });

    it('reports how long the account was below its peak', () => {
        // Measured, not assumed: the account is under water for two trades,
        // takes a new high on the third, goes under for two more, and takes
        // another high on the last. Two, not three — the tempting reading is
        // that the two loss groups and the recovery form one longer spell, and
        // they do not, because the peak moves in the middle.
        const result = pathOf([-0.01, -0.01, 0.05, -0.01, -0.01, 0.2]);

        expect(result.worstStreak).toBe(2);
        expect(result.worstDrawdownRun).toBe(2);
        expect(result.finalReturn).toBeGreaterThan(0);
    });

    it('says how much of the result was the order it happened in', () => {
        // A strategy that made its money in one lucky trade would look far
        // better ordered one way than another, and the share of reshuffles
        // that ended worse is the number a reader should take away.
        const sample = trades([2, ...Array.from({ length: 20 }, () => -0.02)]);
        const result = monteCarlo(sample, FAST, 13)!;

        expect(result.orderIsLuck).toBeGreaterThan(0);
        expect(result.orderIsLuck).toBeLessThanOrEqual(1);
    });

    it('puts the observed path inside the spread it describes', () => {
        const sample = trades(
            Array.from({ length: 30 }, (_, index) =>
                index % 3 === 0 ? 0.03 : -0.01,
            ),
        );
        const result = monteCarlo(sample, FAST, 17)!;

        expect(result.median.finalReturn).toBeCloseTo(
            result.observed.finalReturn,
            10,
        );
    });

    it('reports nothing rather than a confident answer about no trades', () => {
        expect(monteCarlo([], FAST, 1)).toBeNull();
        expect(permutationTest([], totalReturn, FAST, 1)).toBeNull();
    });
});

describe('the maths holds for any set of trades', () => {
    it('keeps every drawdown at or below one and at or above zero', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: -0.9, max: 3, noNaN: true }), {
                    minLength: 1,
                    maxLength: 60,
                }),
                (returns) => {
                    const result = pathOf(returns);

                    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
                    expect(result.maxDrawdown).toBeLessThanOrEqual(1);
                    expect(result.worstStreak).toBeLessThanOrEqual(returns.length);
                    expect(result.worstDrawdownRun).toBeLessThanOrEqual(
                        returns.length,
                    );
                },
            ),
            { numRuns: 200 },
        );
    });

    it('leaves a run of no losses with a zero streak', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
                    minLength: 1,
                    maxLength: 40,
                }),
                (returns) => {
                    expect(pathOf(returns).worstStreak).toBe(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('orders the outcomes, so the median is the median', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: -0.5, max: 1, noNaN: true }), {
                    minLength: 1,
                    maxLength: 40,
                }),
                fc.integer(),
                (returns, seed) => {
                    const result = monteCarlo(trades(returns), FAST, seed)!;
                    const finals = result.outcomes.map((outcome) => outcome.finalReturn);

                    expect([...finals].sort((a, b) => a - b)).toEqual(finals);
                    expect(result.orderIsLuck).toBeGreaterThanOrEqual(0);
                    expect(result.orderIsLuck).toBeLessThanOrEqual(1);
                },
            ),
            { numRuns: 50 },
        );
    });
});

describe('the shipped defaults are not an accident', () => {
    it('are inside the bounds the schema allows', () => {
        expect(() =>
            StatisticsConfigSchema.parse(DEFAULT_STATISTICS_CONFIG),
        ).not.toThrow();
    });
});
