import { describe, expect, it } from 'vitest';

import { requiredCandleCount } from '../config/indicator.config.js';
import type { Candle } from '../types/market.js';
import { computeSignalAt, computeSignalSeries } from './point-in-time.js';
import { DEFAULT_WALK_FORWARD_OPTIONS, runWalkForward, simulateRange } from './walk-forward.js';

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

/**
 * The audit the point-in-time tests cannot do alone.
 *
 * Those tests prove one signal is blind to the bars after it. The engine adds
 * windows, threshold fitting and a validation tail on top, and each of those
 * is one more place a bar from the future could slip in through arithmetic
 * nobody meant to be a window. So the property is asserted at the engine's own
 * output: **a fold is a function of the bars it claims, and no others.** The
 * bar after a fold's test window is rewritten into a violent move, and the
 * fold — its trades, its fitted pair, its validation scores — must not move.
 */
describe('no future reaches a fold', () => {
    const OPTIONS = { foldBars: 100, trainingBars: 200, maxFolds: 3 };

    it('leaves a fold unchanged when every bar after it is rewritten', () => {
        const base = marketCandles(WARMUP + 200 + 3 * 100);
        const baseline = runWalkForward(base, OPTIONS);

        expect(baseline.folds).toHaveLength(3);

        // Folds are reported oldest first, so the first fold is the one whose
        // every later bar belongs to somebody else's window.
        const oldest = baseline.folds[0]!;
        const cut = oldest.endIndex;

        const mutated = base.map((candle, index) =>
            index > cut
                ? {
                      ...candle,
                      open: candle.close * 3,
                      high: candle.close * 4,
                      low: candle.close * 2,
                      close: candle.close * 3.5,
                  }
                : candle,
        );
        const after = runWalkForward(mutated, OPTIONS);

        const sameFold = after.folds.find((fold) => fold.fold === oldest.fold)!;

        // The fold carries its metrics; the trades themselves are pooled on
        // the result and named by the bars they occupy.
        const tradesOf = (
            result: ReturnType<typeof runWalkForward>,
            fold: { startIndex: number; endIndex: number },
        ) =>
            result.trades.filter(
                (trade) =>
                    trade.entryIndex >= fold.startIndex && trade.entryIndex <= fold.endIndex,
            );

        expect(tradesOf(after, sameFold)).toEqual(tradesOf(baseline, oldest));
        expect(sameFold.parameters).toEqual(oldest.parameters);
        expect(sameFold.validation).toEqual(oldest.validation);
        expect(sameFold.metrics).toEqual(oldest.metrics);

        // The rewrite must be visible where it belongs — otherwise this test
        // proves the engine cannot see anything, including its own data.
        const tail = { start: cut + 1, end: base.length - 1 };
        const before = computeSignalSeries(base, tail.start, tail.end)
            .map((point) => point.signal.signal);
        const rewritten = computeSignalSeries(mutated, tail.start, tail.end)
            .map((point) => point.signal.signal);

        expect(rewritten).not.toEqual(before);
    });

    it('recomputes a signal blind to bars that do not exist yet, mid-fold', () => {
        const base = marketCandles(WARMUP + 200 + 100);
        const at = base.length - 20;
        const truncated = base.slice(0, at + 1);

        // The signal computed from a series that *ends* at `at` — the only one
        // a live run at that moment could have produced — must equal the
        // signal the backtest computes for the same bar from a longer series.
        // Anything else is the future answering a question about the past.
        const alone = computeSignalAt(truncated, at);
        const embedded = computeSignalAt(base, at);

        expect(alone).not.toBeNull();
        expect(embedded).not.toBeNull();
        expect(embedded!.signal).toEqual(alone!.signal);
        expect(embedded!.indicators).toEqual(alone!.indicators);
    });

    it('trades nothing when every signal sits outside its window', () => {
        const candles = marketCandles(WARMUP + 300);
        const startIndex = candles.length - 50;
        const endIndex = candles.length - 1;

        const outside = computeSignalSeries(candles, WARMUP, startIndex - 1)
            .map((point, position) => ({
                index: point.index,
                signal: {
                    // Forced directional on both sides, so a refusal to trade
                    // is the engine's and not the rule's.
                    signal: position % 2 === 0 ? 'LONG' : 'SHORT',
                },
            }));

        const result = simulateRange(
            candles,
            outside,
            startIndex,
            endIndex,
            DEFAULT_WALK_FORWARD_OPTIONS,
        );

        expect(result.trades).toEqual([]);
        expect(result.mix).toEqual({ long: 0, short: 0, neutral: 0 });
        expect(result.equity).toHaveLength(50);
        expect(result.equity.every((value) => value === 1)).toBe(true);
    });
});
