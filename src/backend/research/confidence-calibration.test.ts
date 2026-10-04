import { describe, expect, it } from 'vitest';
import type { StrategyModule } from '../strategies/types.js';

import type { Candle } from '../types/market.js';
import { collectConfidences, MINIMUM_BIN_BARS, reliability } from './confidence-calibration.js';

/** A flat market: every bar goes up as often as it goes down, and by the same amount. */
const FLAT: Candle[] = Array.from({ length: 400 }, (_, index) => {
    const close = 100 + (index % 2 === 0 ? 0.1 : -0.1);

    return {
        timestamp: 1_500_000_000_000 + index * 86_400_000,
        open: close,
        high: close * 1.002,
        low: close * 0.998,
        close,
        volume: 1,
    };
});

const rows = (pairs: ReadonlyArray<[number, number]>) =>
    pairs.map(([confidence, forward]) => ({ confidence, forward }));

describe('a calibration that cannot be measured is not a calibration', () => {
    it('says so when the confident bins are too thin, rather than answering', () => {
        // The mistake this file exists to prevent. A boolean said `monotone` for
        // every rule on the market, because it compared a bin of 34 bars with a
        // bin of 6 and called the difference a shape.
        const thin = reliability(
            rows([
                ...Array.from({ length: 40 }, () => [0.05, 0.01] as [number, number]),
                ...Array.from({ length: 6 }, () => [0.75, 0.01] as [number, number]),
            ]),
        );

        expect(thin.verdict).toBe('too-few-bars');
        expect(thin.measurable).toBe(false);
    });

    it('answers once there are enough bars on both sides', () => {
        const enough = reliability([
            ...Array.from({ length: 60 }, (_, i) => ({
                confidence: 0.05,
                forward: i % 2 === 0 ? 0.01 : -0.01,
            })),
            ...Array.from({ length: 60 }, (_, i) => ({
                confidence: 0.75,
                forward: i % 2 === 0 ? 0.01 : -0.01,
            })),
        ]);

        expect(enough.measurable).toBe(true);
        expect(enough.verdict).toBe('flat');
    });

    it('reports monotone only when the upper half genuinely wins more', () => {
        const rising = reliability([
            ...Array.from({ length: 60 }, (_, i) => ({
                confidence: 0.05,
                forward: i < 40 ? -0.01 : 0.01,
            })),
            ...Array.from({ length: 60 }, (_, i) => ({
                confidence: 0.75,
                forward: i < 20 ? -0.01 : 0.01,
            })),
        ]);

        expect(rising.verdict).toBe('monotone');
    });

    it('states the minimum it is judging by, so the boundary is a choice on the page', () => {
        expect(MINIMUM_BIN_BARS).toBeGreaterThan(0);
        // Exactly at the boundary is measurable; one below is not.
        const exact = reliability([
            ...Array.from({ length: MINIMUM_BIN_BARS }, () => ({
                confidence: 0.75,
                forward: 0.01,
            })),
        ]);

        expect(exact.topHalfBars).toBe(MINIMUM_BIN_BARS);
    });
});

describe('the bins are the ones they say they are', () => {
    it('assigns every bar to exactly one bin, and loses none', () => {
        const spread = reliability([
            { confidence: 0, forward: 0.01 },
            { confidence: 0.099, forward: 0.01 },
            { confidence: 0.1, forward: 0.01 },
            { confidence: 0.55, forward: 0.01 },
            { confidence: 0.95, forward: 0.01 },
        ]);

        expect(spread.bins.reduce((total, bin) => total + bin.bars, 0)).toBe(5);
    });

    it('leaves an empty bin empty rather than filling it with zero', () => {
        const report = reliability(rows([[0.05, 0.01]]));

        // A zero would be a bin where nothing went up, which is a claim about
        // the market rather than about the absence of data.
        expect(report.bins.find((bin) => bin.label === '0.70–0.80')?.bars).toBe(0);
        expect(Number.isNaN(report.bins.find((bin) => bin.label === '0.70–0.80')!.winShare)).toBe(
            true,
        );
    });

    it('computes the win share from the forwards, not from the label', () => {
        const report = reliability(
            rows([
                [0.05, 0.01],
                [0.05, -0.01],
                [0.05, 0.02],
                [0.05, 0.0],
            ]),
        );
        const bin = report.bins.find((entry) => entry.label === '0.00–0.10')!;

        // Two of the four forwards are positive; the 0.0 is not a win, which is
        // why there are four rows for two wins.
        expect(bin.winShare).toBeCloseTo(0.5, 12);
    });
});

describe('collecting the numbers a rule produced', () => {
    it('reads the confidence off the module rather than off the bench adapter', () => {
        // The adapter collapses a decision to 1|0|-1 and throws away the number
        // under investigation, which is why this takes the module.
        const module: StrategyModule = {
            key: 'donchian-20',
            name: 'test',
            mechanism: 'A mechanism long enough to satisfy the registry, written out in full.',
            warmup: 0,
            evaluate: ({ price }) => ({
                direction: 'LONG',
                confidence: price,
                reason: 'test',
                warm: false,
            }),
        };

        const found = collectConfidences(module, FLAT);

        expect(found.length).toBe(FLAT.length - 1);
        expect(found[0]?.confidence).toBeCloseTo(FLAT[0]!.close, 12);
    });

    it('takes only the longs, and pairs each with the bar that followed', () => {
        const module: StrategyModule = {
            key: 'donchian-20',
            name: 'test',
            mechanism: 'A mechanism long enough to satisfy the registry, written out in full.',
            warmup: 0,
            evaluate: ({ candles }) => ({
                direction: candles.length % 2 === 0 ? 'LONG' : 'SHORT',
                confidence: 0.5,
                reason: 'test',
                warm: false,
            }),
        };

        const found = collectConfidences(module, FLAT);

        expect(found.every((row) => row.confidence === 0.5)).toBe(true);
        // The series rises on even indices and falls on odd ones. The module
        // fires on an even `candles.length`, which is an odd index, so every
        // long is followed by a rising bar — and the forward return the
        // calibration sees is the rise, not the fall.
        expect(found.every((row) => row.forward > 0)).toBe(true);
    });

    it('measures from the bar the signal was on, not the bar it was filled on', () => {
        // Otherwise the calibration would depend on the execution model, and
        // the execution model has already moved once this month.
        const module: StrategyModule = {
            key: 'donchian-20',
            name: 'test',
            mechanism: 'A mechanism long enough to satisfy the registry, written out in full.',
            warmup: 0,
            evaluate: () => ({
                direction: 'LONG',
                confidence: 0.5,
                reason: 'test',
                warm: false,
            }),
        };

        const oneBar = collectConfidences(module, FLAT, { forwardBars: 1 });
        const twoBars = collectConfidences(module, FLAT, { forwardBars: 2 });

        expect(oneBar.length).toBe(FLAT.length - 1);
        expect(twoBars.length).toBe(FLAT.length - 2);
        expect(oneBar[0]?.forward).not.toBeCloseTo(twoBars[0]!.forward, 12);
    });
});
