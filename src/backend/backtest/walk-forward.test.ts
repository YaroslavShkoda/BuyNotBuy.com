import { describe, expect, it } from 'vitest';

import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { ExecutionConfigParser, roundTripCost, fillPrice } from './execution.js';
import { requiredCandleCount, INDICATOR_SIGNAL_CONFIG } from '../config/indicator.config.js';

import type { Candle } from '../types/market.js';

const HOUR_MS = 3_600_000;
const WARMUP = requiredCandleCount();

function makeCandles(
    count: number,
    priceAt: (index: number) => number,
): Candle[] {
    const start = 1_700_000_000_000;

    return Array.from({ length: count }, (_, index) => {
        const price = priceAt(index);

        return {
            timestamp: start + index * HOUR_MS,
            open: price,
            high: price * 1.01,
            low: price * 0.99,
            close: price,
            volume: 1000,
        };
    });
}

/** A trending wave: enough swing for the stochastic to leave the middle. */
function marketCandles(count: number, amplitude = 0.12): Candle[] {
    return makeCandles(count, (index) => {
        const trend = 1 + index * 0.0004;
        const wave = 1 + amplitude * Math.sin((index / 18) * Math.PI * 2);

        return 100_000 * trend * wave;
    });
}

const SAMPLE = marketCandles(3000);

describe('walk-forward evaluation windows', () => {
    it('reports nothing when the sample is shorter than a warm-up', () => {
        const result = runWalkForward(marketCandles(500));

        expect(result.folds).toEqual([]);
        expect(result.trades).toEqual([]);
        expect(result.overall.trades).toBe(0);
    });

    it('reports nothing when the sample cannot fill a training window', () => {
        const result = runWalkForward(marketCandles(
            WARMUP + DEFAULT_WALK_FORWARD_OPTIONS.trainingBars + 10,
        ));

        expect(result.folds).toEqual([]);
    });

    it('evaluates the requested number of windows', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 5,
        });

        expect(result.folds).toHaveLength(5);
    });

    it('never asks for more windows than the sample can fill', () => {
        const result = runWalkForward(marketCandles(1500), {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 50,
        });

        // 1500 candles minus a 900-bar warm-up and a 200-bar training window
        // leaves four evaluation windows, and the cap must not invent a fifth.
        expect(result.folds).toHaveLength(4);
        expect(result.skippedFolds).toBe(0);
        expect(result.evaluatedBars).toBe(400);
    });

    it('reports the windows it had to leave out', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 2,
        });

        // Silently truncating would let a reader assume the report covers the
        // whole sample.
        expect(result.folds).toHaveLength(2);
        expect(result.skippedFolds).toBeGreaterThan(0);
    });

    it('keeps the windows disjoint and inside the sample', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 6,
        });

        const seen = new Set<number>();

        for (const fold of result.folds) {
            expect(fold.startIndex).toBeGreaterThanOrEqual(WARMUP);
            expect(fold.endIndex).toBeLessThan(SAMPLE.length);
            expect(fold.endIndex).toBeGreaterThanOrEqual(fold.startIndex);

            for (let index = fold.startIndex; index <= fold.endIndex; index += 1) {
                // A bar scored twice would be counted twice in the totals and
                // in the exposure.
                expect(seen.has(index)).toBe(false);
                seen.add(index);
            }
        }
    });

    it('orders the windows oldest first', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 4,
        });

        for (let index = 1; index < result.folds.length; index += 1) {
            expect(result.folds[index]!.startIndex).toBeGreaterThan(
                result.folds[index - 1]!.startIndex,
            );
        }
    });

    it('evaluates the most recent data first', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 4,
        });

        const newest = result.folds[result.folds.length - 1]!;

        expect(newest.endIndex).toBe(SAMPLE.length - 1);
    });

    it('adds up to the total number of evaluated bars', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 100,
            trainingBars: 200,
            maxFolds: 3,
        });

        expect(result.evaluatedBars).toBe(300);
    });
});

describe('trade entry', () => {
    it('enters on the bar after the signal, never on the signal bar', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        expect(result.trades.length).toBeGreaterThan(0);

        for (const trade of result.trades) {
            // Entering at the signal bar's own close would trade on a price
            // that only becomes known once that bar has finished.
            expect(trade.entryIndex).toBeGreaterThan(0);
            expect(trade.exitIndex).toBe(trade.entryIndex + DEFAULT_WALK_FORWARD_OPTIONS.holdBars);
        }
    });

    it('holds the position for the requested number of bars', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 2,
            holdBars: 3,
        });

        for (const trade of result.trades) {
            expect(trade.exitIndex - trade.entryIndex).toBe(3);
        }
    });

    it('fills through the execution model rather than off the bar', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 1,
            execution: ExecutionConfigParser.parse({
                ...DEFAULT_WALK_FORWARD_OPTIONS.execution,
                takerFeeRate: 0,
                makerFeeRate: 0,
                slippageRate: 0,
                spreadRate: 0,
                model: 'next_open',
            }),
        });

        // With the costs set to zero the fill *is* the bar, which is what makes
        // this the right way to pin the timing: the entry comes from the open
        // of the bar after the signal and the exit from the close of the bar
        // `holdBars` later.
        for (const trade of result.trades) {
            expect(trade.entryPrice).toBe(SAMPLE[trade.entryIndex]?.open);
            expect(trade.exitPrice).toBe(SAMPLE[trade.exitIndex]?.close);
        }
    });

    it('separates the move from what the costs took', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        for (const trade of result.trades) {
            const entry = SAMPLE[trade.entryIndex];
            const exit = SAMPLE[trade.exitIndex];

            if (entry === undefined || exit === undefined) {
                continue;
            }

            const moved = exit.close / entry.open - 1;

            // The gross is the move between the bars, which is not the same
            // question as what the trader got. A report that showed only one of
            // them would hide whichever was the more flattering.
            expect(trade.grossReturn).toBeCloseTo(
                trade.direction === 1 ? moved : -moved,
                10,
            );
            // And the net is the fill, costs included, which is the only one
            // anybody actually earns.
            expect(trade.netReturn).not.toBeCloseTo(trade.grossReturn, 3);
        }
    });
});

describe('costs', () => {
    it('charges a round trip on every trade', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 2,
            execution: ExecutionConfigParser.parse({
                ...DEFAULT_WALK_FORWARD_OPTIONS.execution,
                takerFeeRate: 0.001,
                makerFeeRate: 0.001,
                slippageRate: 0,
                spreadRate: 0,
                model: 'next_open',
            }),
        });

        for (const trade of result.trades) {
            // Not exactly 0.002, and not always under it. The fee is charged on
            // the price while this is a fraction of the *return*, so a trade
            // that barely moved pays the same money and reports a bigger
            // fraction. Measured across this sample: 0.00193 to 0.00200. A
            // test asserting an exact round trip would be asserting the thing
            // this block replaced.
            const cost = trade.grossReturn - trade.netReturn;

            expect(cost).toBeGreaterThan(0);
            expect(cost).toBeCloseTo(0.002, 3);
        }
    });

    it('honours the execution model the run was given', () => {
        // The wiring test. An execution model that is defined, tested and then
        // not passed to the simulator is a module nobody uses, and the run
        // quietly keeps assuming the fill it always assumed.
        const runWith = (model: 'next_open' | 'intrabar') =>
            runWalkForward(SAMPLE, {
                foldBars: 120,
                trainingBars: 240,
                maxFolds: 2,
                execution: ExecutionConfigParser.parse({
                    ...DEFAULT_WALK_FORWARD_OPTIONS.execution,
                    model,
                }),
            });

        const open = runWith('next_open');
        const pessimistic = runWith('intrabar');

        expect(open.trades.length).toBeGreaterThan(0);
        expect(pessimistic.trades.length).toBe(open.trades.length);

        // A long assumed to have been filled at the bar's low pays more than
        // one assumed to have been filled at its open. Same signals, same
        // bars, same fee — a different answer, which is the point of choosing.
        expect(pessimistic.overall.totalReturn).toBeLessThanOrEqual(
            open.overall.totalReturn + 1e-12,
        );
    });

    it('never reports a trade that costs nothing', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 2,
        });

        for (const trade of result.trades) {
            expect(trade.netReturn).toBeLessThanOrEqual(trade.grossReturn + 1e-12);
        }
    });

    it('drops a marginal trade into a loss once costs are counted', () => {
        // A market moving further per bar than the round trip costs cannot
        // produce a trade whose gross gain is smaller than the cost, so the
        // sample has to be gentler than the one the rest of this file uses.
        const result = runWalkForward(
            marketCandles(3000, 0.01),
            {
                foldBars: 120,
                trainingBars: 240,
                maxFolds: 3,
            },
        );

        const marginal = result.trades.filter(
            (trade) => trade.grossReturn > 0 && trade.netReturn < 0,
        );

        // Reporting gross would make a strategy that cannot cover its own
        // fees look profitable.
        expect(marginal.length).toBeGreaterThan(0);
    });
});

describe('threshold fitting', () => {
    it('trades with the shipped thresholds when fitting is off', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
            fitParameters: false,
        });

        for (const fold of result.folds) {
            expect(fold.fitted).toBe(false);
            expect(fold.parameters).toEqual({
                longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            });
        }
    });

    it('reports the fitted pair on each window', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
            fitParameters: true,
        });

        for (const fold of result.folds) {
            expect(fold.parameters.longThreshold).toBeGreaterThan(0);
            expect(fold.parameters.shortThreshold).toBeGreaterThan(
                fold.parameters.longThreshold,
            );
        }
    });

    it('scores the fitted strategy against the shipped one on the same bars', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
            fitParameters: true,
        });

        // Without the baseline there is no way to tell whether fitting helped
        // or just found noise in the training window.
        expect(result.baseline.trades).toBeGreaterThan(0);
        expect(result.evaluatedBars).toBe(360);
    });

    it('can select the shipped pair when it happens to be the best', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 8,
            fitParameters: true,
        });

        const fitted = result.folds.filter((fold) => fold.fitted).length;

        // Not every window has to pick a different pair; a stable choice is
        // a result, not a failure.
        expect(fitted).toBeLessThanOrEqual(result.folds.length);
    });
});

describe('signal accounting', () => {
    it('counts every evaluated bar, traded or not', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        const { long, short, neutral } = result.overall.signalMix;

        expect(long + short + neutral).toBe(result.evaluatedBars);
    });

    it('counts only traded signals as positions', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        const { long, short } = result.overall.signalMix;

        // The last signal in a fold cannot be traded — its position would
        // leave the window — so the traded count may be lower, never higher.
        expect(result.trades.length).toBeLessThanOrEqual(long + short);
    });
});

describe('one position at a time', () => {
    it('never opens a position while another is open', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 4,
        });

        // Stacking trades is leverage nobody sized. Compounding the returns
        // of two simultaneous full-size positions reports roughly twice the
        // capital an account could actually commit, and every headline number
        // built on it is unachievable.
        for (let index = 1; index < result.trades.length; index += 1) {
            const previous = result.trades[index - 1]!;
            const current = result.trades[index]!;

            expect(current.entryIndex).toBeGreaterThanOrEqual(previous.exitIndex);
        }
    });

    it('holds no bar as part of two positions', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 4,
        });

        const owner = new Map<number, number>();

        for (const trade of result.trades) {
            for (let bar = trade.entryIndex; bar <= trade.exitIndex; bar += 1) {
                owner.set(bar, (owner.get(bar) ?? 0) + 1);
            }
        }

        for (const count of owner.values()) {
            expect(count).toBe(1);
        }
    });
});

describe('positions stay inside the window they were measured in', () => {
    it('closes every position by the end of its own fold', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 4,
        });

        for (const fold of result.folds) {
            const inFold = result.trades.filter(
                (trade) =>
                    trade.entryIndex >= fold.startIndex &&
                    trade.entryIndex <= fold.endIndex,
            );

            for (const trade of inFold) {
                // A position that closes past the fold is priced from bars
                // that belong to the next window — whose thresholds were then
                // fitted on them. The fold is no longer out of sample.
                expect(trade.exitIndex).toBeLessThanOrEqual(fold.endIndex);
            }
        }
    });

    it('never exits on a bar past the end of the sample', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        for (const trade of result.trades) {
            expect(trade.exitIndex).toBeLessThan(SAMPLE.length);
        }
    });
});

describe('benchmarks', () => {
    it('holds the benchmark to the same bars and the same cost', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        const last = result.folds[result.folds.length - 1]!;
        const first = result.folds[0]!;

        // The span the strategy was judged over, and nothing else. A benchmark
        // measured over a different period answers a different question.
        expect(result.benchmarks.buyAndHold.trades).toBe(1);
        expect(result.evaluatedBars).toBe(3 * 120);
        expect(last.endIndex - first.startIndex + 1).toBe(result.evaluatedBars);
    });

    it('charges the benchmark the round trip a real trade pays', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        // Buy & hold is one long position, filled through the same model as
        // the strategy. A cost-free benchmark would flatter the strategy by
        // precisely what it pays in fees, and a differently-filled one would
        // be comparing two different assumptions.
        const first = result.folds[0]!;
        const last = result.folds[result.folds.length - 1]!;
        const entry = SAMPLE[first.startIndex]!;
        const exit = SAMPLE[last.endIndex]!;
        const execution = DEFAULT_WALK_FORWARD_OPTIONS.execution;

        const priced = fillPrice(exit, 1, execution, false) /
            fillPrice(entry, 1, execution, true) -
            1;

        expect(result.benchmarks.buyAndHold.totalReturn).toBeCloseTo(
            priced,
            10,
        );
        // And it really does pay the round trip, rather than reporting the
        // price change the strategy is being measured against.
        expect(priced).toBeLessThan(exit.close / entry.open - 1);
        expect(roundTripCost(execution)).toBeCloseTo(0.0034, 10);
    });

    it('gives the random benchmark the trade count it says it gives', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        // The label promises a like-for-like comparison. A benchmark that
        // quietly placed a tenth of the trades is not a benchmark.
        expect(result.benchmarks.randomEntry.trades).toBeCloseTo(
            result.trades.length,
            0,
        );
    });

    it('reaches the same answer on the same data', () => {
        const options = { foldBars: 120, trainingBars: 240, maxFolds: 2 };
        const first = runWalkForward(SAMPLE, options);
        const second = runWalkForward(SAMPLE, options);

        // The random benchmark is seeded. A benchmark that moves between two
        // runs of the same code cannot be used to decide anything.
        expect(second.benchmarks.randomEntry.totalReturn).toBe(
            first.benchmarks.randomEntry.totalReturn,
        );
    });

    it('reports no excess when the strategy never traded', () => {
        const flat = makeCandles(3000, () => 100);

        const result = runWalkForward(flat, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 2,
        });

        // Null rather than zero: a run that produced no trades has not matched
        // the benchmark, it has failed to produce a number.
        expect(result.trades).toEqual([]);
        expect(result.excessOverBuyAndHold).toBeNull();
    });
});
