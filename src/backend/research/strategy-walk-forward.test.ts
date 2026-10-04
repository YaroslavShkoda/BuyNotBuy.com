import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import type { Strategy } from './strategies.js';
import { runStrategy } from './strategies.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';

/**
 * The point of these tests is that walk-forward can fail.
 *
 * A harness whose verdict is always "yes" is not being tested, it is being
 * admired. So most of what follows builds a rule that makes money overall and
 * is still rejected, because a rule that wins in three windows and loses in
 * seven has not been validated no matter what its total says.
 */

/**
 * A synthetic series.
 *
 * `spread` is the half-width of every bar's high-low range. It is a parameter
 * because it is not a detail: under a genuinely pessimistic execution model a
 * long enters at the high and exits at the low, so a 1% half-width costs 2% a
 * trade, and a series whose drift is smaller than that cannot be profitable at
 * any threshold. The default is left at 1% because the other tests in this file
 * were written against it; anything testing a premise about profitability has
 * to say what width it is assuming, or it is measuring its own fixture.
 */
function candles(count: number, step: (index: number) => number, spread = 0.01): Candle[] {
    return Array.from({ length: count }, (_, index) => {
        const close = step(index);

        return {
            timestamp: 1_500_000_000_000 + index * 86_400_000,
            open: close,
            high: close * (1 + spread),
            low: close * (1 - spread),
            close,
            volume: 1,
        };
    });
}

/** A rule that trades a fixed fraction of the time, always long. */
function stepRule(period: number, label = 'step'): Strategy {
    return {
        name: label,
        mechanism: 'перемещается фиксированными шагами',
        warmup: period,
        decide({ candles: visible, index }) {
            if (index < period) {
                return 0;
            }

            // Guarded against period 0 on purpose: a harness whose own rule
            // divides by zero returns "no trades" everywhere and then reports
            // that as a result about the strategy rather than about itself.
            const step = period === 0 ? 0 : Math.floor(index / period);

            return (index + step) % 3 === 0 ? 1 : 0;
        },
    };
}

/** A rule that is silent, so a fold can contain no trades at all. */
const SILENT: Strategy = {
    name: 'silent',
    mechanism: 'никогда не торгует',
    warmup: 0,
    decide: () => 0,
};

describe('walk-forward judges windows, not totals', () => {
    it('rejects a rule that is profitable overall and fails in a third of the windows', () => {
        // Rises gently except in one window, where it collapses. The full
        // sample is strongly positive, which is the number a plain backtest
        // would have printed.
        //
        // The 0.1% half-width is stated rather than defaulted because it
        // matters: the intrabar model is fixed to be pessimistic on both legs —
        // a long now enters at the bar's high and exits at its low — so the
        // fixture's own width is a round-trip cost. At the 1% this file uses by
        // default, no plausible drift survives it, and the test would have
        // stopped testing its premise and started testing its fixture.
        const series = candles(
            1000,
            (index) => {
                if (index >= 300 && index < 360) {
                    return 100 * 0.7 ** ((index - 300) / 10);
                }

                return 100 * 1.002 ** index;
            },
            0.001,
        );

        const strategy = stepRule(20);
        const verdict = walkForwardStrategy(strategy, series, {
            foldBars: 100,
            barsPerYear: 365,
        });

        // The premise, asserted rather than assumed: the rule does make money
        // on the sample as a whole. Without this the test would pass for the
        // wrong reason and be testing nothing.
        expect(runStrategy(strategy, series, { barsPerYear: 365 }).metrics.totalReturn)
            .toBeGreaterThan(0);

        expect(verdict.consistent).toBe(false);
        expect(verdict.worstFold).toBeLessThan(0);
        expect(verdict.reason).toContain('правило');
    });

    it('refuses to judge a sample too short to have an opinion', () => {
        const verdict = walkForwardStrategy(stepRule(20), candles(220, (i) => 100 + i), {
            foldBars: 100,
        });

        expect(verdict.folds.length).toBe(2);
        expect(verdict.consistent).toBe(false);
        expect(verdict.reason).toContain('слишком мало складок');
    });

    it('reports zero share rather than dividing by no folds', () => {
        const verdict = walkForwardStrategy(SILENT, candles(150, (i) => 100 + i), {
            foldBars: 100,
        });

        expect(verdict.folds.length).toBe(1);
        expect(verdict.profitableShare).toBe(0);
        expect(verdict.bestFold).toBe(0);
    });
});

describe('a fold sees only its own window', () => {
    it('gives a rule that needs history fewer windows to be judged in', () => {
        // Measured, not assumed — the first version of this test asserted the
        // opposite inequality, on an intuition about which side would trade
        // more. A rule whose warmup eats the front of the sample gets fewer
        // folds, and that loss has to be visible rather than papered over by
        // quietly starting the walk later.
        const series = candles(1000, (index) => 100 * 1.01 ** index);

        const noHistory = walkForwardStrategy(stepRule(0), series, { foldBars: 100 });
        const withHistory = walkForwardStrategy(stepRule(50), series, {
            foldBars: 100,
        });

        expect(noHistory.folds.length).toBe(10);
        expect(withHistory.folds.length).toBe(9);
        expect(noHistory.folds[0]!.startIndex).toBe(0);
        expect(withHistory.folds[0]!.startIndex).toBe(50);
    });

    it('gives every fold the same number of tradeable bars', () => {
        // The history in front of a fold is supplied purely as warm up, so
        // every fold is offered the same 100 bars. That is what makes the
        // per-fold results comparable, and it is the opposite of what the first
        // version of this test assumed — it expected the first fold to trade
        // less, and the run showed it trades exactly as much as the rest.
        const series = candles(1000, (index) => 100 * 1.01 ** index);

        const verdict = walkForwardStrategy(stepRule(80), series, {
            foldBars: 100,
        });

        const counts = new Set(verdict.folds.map((fold) => fold.trades));
        expect(counts.size).toBe(1);
        expect(verdict.folds[0]!.startIndex).toBe(80);
    });

    it('has nothing to say about a rule that needs more history than the sample holds', () => {
        // The only real edge case. A rule whose warmup exceeds the whole
        // sample produces no folds, and a verdict over zero folds is reported
        // as insufficient rather than as a clean bill of health.
        const verdict = walkForwardStrategy(stepRule(1200), candles(1000, (i) => 100 + i), {
            foldBars: 100,
        });

        expect(verdict.folds).toHaveLength(0);
        expect(verdict.profitableShare).toBe(0);
        expect(verdict.consistent).toBe(false);
        expect(verdict.reason).toContain('слишком мало складок');
    });

    it('judges a rule whose warmup is longer than a single fold, on full folds', () => {
        // Because the history in front of a fold is supplied, a long warmup
        // costs the sample its *windows*, not the windows their depth. Getting
        // this wrong in the other direction — dropping the first fold because
        // it was warming up — is the silent version of the same mistake.
        const verdict = walkForwardStrategy(stepRule(500), candles(1000, (i) => 100 + i), {
            foldBars: 100,
        });

        expect(verdict.folds).toHaveLength(5);
        expect(verdict.folds[0]!.startIndex).toBe(500);
        expect(new Set(verdict.folds.map((fold) => fold.endIndex - fold.startIndex)).size).toBe(1);
    });

    it('keeps folds disjoint and in order', () => {
        const verdict = walkForwardStrategy(stepRule(10), candles(800, (i) => 100 + i), {
            foldBars: 100,
        });

        for (let index = 1; index < verdict.folds.length; index += 1) {
            expect(verdict.folds[index]!.startIndex).toBe(
                verdict.folds[index - 1]!.endIndex,
            );
        }
    });
});

describe('a rule that trades nothing is told so', () => {
    it('is a result, not an absence', () => {
        const verdict = walkForwardStrategy(SILENT, candles(600, (i) => 100 + i), {
            foldBars: 100,
        });

        for (const fold of verdict.folds) {
            expect(fold.trades).toBe(0);
            expect(fold.totalReturn).toBe(0);
            expect(fold.profitFactor).toBeNull();
        }
    });
});
