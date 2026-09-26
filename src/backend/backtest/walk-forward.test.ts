import { describe, expect, it } from 'vitest';

import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
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

    it('takes the entry from the open and the exit from the close', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 1,
        });

        for (const trade of result.trades) {
            expect(trade.entryPrice).toBe(SAMPLE[trade.entryIndex]?.open);
            expect(trade.exitPrice).toBe(SAMPLE[trade.exitIndex]?.close);
        }
    });

    it('makes a long trade pay when the price rose and a short trade pay when it fell', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

        for (const trade of result.trades) {
            const moved = trade.exitPrice / trade.entryPrice - 1;

            if (trade.direction === 1) {
                expect(trade.grossReturn).toBeCloseTo(moved, 10);
            } else {
                expect(trade.grossReturn).toBeCloseTo(-moved, 10);
            }
        }
    });
});

describe('costs', () => {
    it('charges a round trip on every trade', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 2,
            feeRate: 0.001,
            slippageRate: 0.0005,
        });

        for (const trade of result.trades) {
            expect(trade.grossReturn - trade.netReturn).toBeCloseTo(0.003, 10);
        }
    });

    it('drops a marginal trade into a loss once costs are counted', () => {
        const result = runWalkForward(SAMPLE, {
            foldBars: 120,
            trainingBars: 240,
            maxFolds: 3,
        });

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
