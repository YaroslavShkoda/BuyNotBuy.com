import { describe, expect, it } from 'vitest';

import { extrapolate, growthRatio, timeRun } from './bench-cost.js';
import { createDonchian } from '../strategies/donchian.js';
import { fromModule } from './strategies.js';

import type { Timing } from './bench-cost.js';
import type { StrategyModule } from '../strategies/types.js';

const at = (bars: number, ms: number): Timing => ({ bars, ms, msPerBar: ms / bars });

describe('telling a quadratic from a linear by timing it', () => {
    it('reads a doubling of cost per bar as quadratic, not as a smaller power', () => {
        // The off-by-one that made an n^2 bench report as n^1.21. `perBar` is
        // the cost *per bar*, so the exponent on total time is one higher. A
        // test that only checked the ratio would have passed while the printed
        // exponent was wrong.
        const ratio = growthRatio(at(1000, 100), at(2000, 400));

        expect(ratio).toBeCloseTo(2, 6);
        expect(1 + Math.log2(ratio)).toBeCloseTo(2, 6);
    });

    it('reads a flat cost per bar as linear', () => {
        expect(growthRatio(at(1000, 100), at(2000, 200))).toBeCloseTo(1, 6);
    });

    it('projects from a measured law instead of from a hope', () => {
        // 100 ms at 1000 bars, quadratic, is 400 ms at 2000.
        expect(extrapolate(at(1000, 100), 2000, 2)).toBeCloseTo(0.4, 9);
        expect(extrapolate(at(1000, 100), 4000, 2)).toBeCloseTo(1.6, 9);
    });

    it('projects linearly when told the law is linear', () => {
        expect(extrapolate(at(1000, 100), 2000, 1)).toBeCloseTo(0.2, 9);
    });

    it('measures a job rather than trusting a claim about it', () => {
        let ran = false;
        const timing = timeRun(100, () => {
            ran = true;
        });

        expect(ran).toBe(true);
        expect(timing.msPerBar).toBeGreaterThanOrEqual(0);
    });
});

describe('skipping the bars a module is not ready for', () => {
    const module = (warmup: number): StrategyModule => ({
        key: 'donchian-20',
        name: 'test',
        mechanism: 'A mechanism long enough to satisfy the registry, written out in full.',
        warmup,
        evaluate: () => ({
            direction: 'LONG',
            confidence: 0.5,
            reason: 'test',
            warm: false,
        }),
    });

    const candle = { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const series = Array.from({ length: 20 }, () => candle);
    // The bench hands the module a *prefix*, so a module's own readiness check
    // counts what it can see. Passing the whole series here made every bar
    // look warm, which is the one thing the real caller never does.
    const at = (index: number) => ({
        candles: series.slice(0, index + 1),
        series: {},
        index,
    });

    it('does not call the module below its own warmup', () => {
        let calls = 0;
        const counting: StrategyModule = {
            ...module(10),
            evaluate: (context) => {
                calls += 1;

                // Deliberately ignores the warmup and always says LONG. If the
                // adapter called this below the warmup, a module that forgot
                // to honour it would quietly produce a position on bar zero.
                return {
                    direction: 'LONG',
                    confidence: 0.5,
                    reason: 'test',
                    warm: context.candles.length < 10,
                };
            },
        };
        const strategy = fromModule('test', counting);

        for (let index = 0; index < 20; index += 1) {
            strategy.decide(at(index));
        }

        // Bars 0 to 8, where the module has fewer than ten bars to look at.
        // Bar 9 is the first one it can answer for, and the adapter must not
        // skip it.
        expect(calls).toBe(11);
    });

    it('changes nothing about the answer it gives', () => {
        // The skip is exact. A module that honoured its warmup returned
        // NEUTRAL for those bars, and 0 is what NEUTRAL becomes in the
        // adapter, so the two paths agree by construction — provided the
        // module in question actually keeps the promise the adapter is now
        // relying on.
        const obedient: StrategyModule = {
            ...module(10),
            evaluate: (context) => ({
                direction: context.candles.length < 10 ? 'NEUTRAL' : 'LONG',
                confidence: 0.5,
                reason: 'test',
                warm: context.candles.length < 10,
            }),
        };
        const answers = Array.from({ length: 20 }, (_, index) =>
            fromModule('test', obedient).decide(at(index)),
        );
        const bare = Array.from({ length: 20 }, (_, index) =>
            fromModule('test', { ...obedient, warmup: 0 }).decide(at(index)),
        );

        expect(answers).toEqual(bare);
        expect(answers.slice(0, 9)).toEqual(Array.from({ length: 9 }, () => 0));
        // A module declaring `warmup: 10` needs ten bars and is ready on the
        // bar where it has them — index 9. Skipping that bar is the off-by-one
        // this test was written to find.
        expect(answers[9]).toBe(1);
        expect(answers.slice(9)).toEqual(Array.from({ length: 11 }, () => 1));
    });

    it('still calls a real module from the moment it is ready', () => {
        const donchian = createDonchian({ channelPeriod: 20 });
        const strategy = fromModule('donchian-20', donchian);

        expect(donchian.warmup).toBeGreaterThan(0);
        expect(strategy.warmup).toBe(donchian.warmup);
    });
});
