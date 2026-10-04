import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';

import type { WalkForwardVerdict } from './strategy-walk-forward.js';
import { clears, loadDaily, measurePassRates, randomLongRule } from './threshold-null.js';

/**
 * A short series is enough: the question here is what the walk-forward verdict
 * does with a rule that has no hypothesis, and that does not depend on the
 * length of the history. Long enough for folds to exist, short enough that
 * hundreds of them run in a test.
 */
const SERIES: Candle[] = Array.from({ length: 900 }, (_, index) => {
    const close = 100 * 1.0004 ** index + (index % 37 === 0 ? -3 : 0);

    return {
        timestamp: 1_500_000_000_000 + index * 86_400_000,
        open: close,
        high: close * 1.005,
        low: close * 0.995,
        close,
        volume: 1,
    };
});

describe('a rule with no hypothesis still gets a verdict', () => {
    it('runs, and does not silently trade nothing', () => {
        const rates = measurePassRates(SERIES, { rules: 12, foldBars: 100 });

        expect(rates.folds).toBeGreaterThan(3);
        // A control that traded nothing would clear every bar by not losing
        // anything, and the number this file exists to produce would be a
        // statement about a rule that never ran.
        expect(rates.mostTrades).toBeGreaterThan(50);
    });

    it('is reproducible, so two runs can be compared', () => {
        const first = measurePassRates(SERIES, { rules: 10, foldBars: 100, seed: 5 });
        const again = measurePassRates(SERIES, { rules: 10, foldBars: 100, seed: 5 });
        const other = measurePassRates(SERIES, { rules: 10, foldBars: 100, seed: 6 });

        expect(again).toEqual(first);
        expect(other).not.toEqual(first);
    });

    it('gives the same answer for the same rule, whatever the run', () => {
        const rule = randomLongRule(11, 0.4, 20);

        // The rule closes over its own generator, so two calls walk the same
        // sequence. That is the property that makes the seeded sweep mean
        // anything: a control that changed shape between calls could not be
        // compared with a rule that did not.
        expect(rule.decide({ candles: SERIES, index: 100 } as never)).toBe(
            rule.decide({ candles: SERIES, index: 100 } as never),
        );
    });
});

describe('the bar, and which half of it is doing the work', () => {
    it('can only pass if both halves pass', () => {
        // Structural, and true on any series: the bar is a conjunction, so it
        // cannot pass more often than either of its clauses on its own.
        const rates = measurePassRates(SERIES, { rules: 60, foldBars: 100 });

        expect(rates.atSixty).toBeLessThanOrEqual(rates.shareOnly);
        expect(rates.atSixty).toBeLessThanOrEqual(rates.worstOnly);
        expect(rates.atHalf).toBeLessThanOrEqual(rates.atSixty);
        expect(rates.atSeventy).toBeLessThanOrEqual(rates.atSixty);
    });

    it('is blocked by the worst-fold clause alone, on real market data', () => {
        // The finding, on the data it is about. Four hundred coins is the
        // project's figure; forty is enough to see a 0% and keeps the test
        // honest about what it is claiming — this is not a rate, it is an
        // observation that the clause has never once been satisfied.
        //
        // On Binance BTCUSDT, 2096 daily bars, folds of 250: no random
        // long-only rule at 40% exposure has a positive worst fold, while
        // about 4% clear the fold-share clause. `volatility-trend`'s 62.5% is
        // inside the range a coin reaches, and the worst fold that stops it is
        // the same one that stops all four hundred.
        const rates = measurePassRates(loadDaily('btcusdt-1d-binance.csv'), {
            rules: 40,
            foldBars: 250,
        });

        expect(rates.worstOnly).toBe(0);
        expect(rates.atSixty).toBe(0);
        // And the other half is not vacuous: coins do clear it sometimes,
        // which is exactly why it cannot be the clause that does the work.
        expect(rates.shareOnly).toBeGreaterThan(0);
        expect(rates.bestWorstFold).toBeLessThan(0);
    });
});

describe('clearing a bar means both of its halves', () => {
    const verdict = (
        profitableShare: number,
        worstFold: number,
    ): WalkForwardVerdict =>
        ({
            folds: [],
            profitableShare,
            worstFold,
            bestFold: 0,
            consistent: profitableShare >= 0.6 && worstFold > 0,
            reason: '',
        }) as WalkForwardVerdict;

    it('needs a positive worst fold as well as the fold share', () => {
        // A rule can win five windows in six and still lose the gate on the
        // sixth, and that is the case the clause exists for. Asserting the
        // conjunction rather than either half is the only way this can be
        // tested — the previous test in this project did, which is how the
        // walk-forward bar ended up passing rules it should not have.
        expect(clears(verdict(0.75, -0.01), 0.6)).toBe(false);
        expect(clears(verdict(0.75, 0.01), 0.6)).toBe(true);
        expect(clears(verdict(0.5, 0.01), 0.6)).toBe(false);
    });

    it('treats a zero worst fold as failing, because zero is not positive', () => {
        expect(clears(verdict(1, 0), 0.6)).toBe(false);
    });
});
