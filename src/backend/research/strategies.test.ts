import { describe, expect, it } from 'vitest';

import { CANDIDATE_STRATEGIES, runStrategy, buildSeries, fromModule } from './strategies.js';
import { createDonchian } from '../strategies/donchian.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';

import type { StrategyModule } from '../strategies/types.js';
import type { Candle } from '../types/market.js';

const DAY = 86_400_000;

/**
 * A drifting market with a swing longer than any channel window here.
 *
 * The first version of this helper wobbled by 1% over seven bars. That is too
 * small to clear a fifty-five bar channel and too tight to reach a Bollinger
 * band, so a breakout or reversion rule correctly did nothing on it — and a
 * rule that did nothing is indistinguishable from a rule that is broken. A
 * forty-five bar cycle at nine percent is long enough for a channel to be
 * crossed and broken, which is what these rules are for.
 */
function series(count: number, drift = 0.0008): Candle[] {
    const newestOpen = Math.floor(Date.now() / DAY) * DAY;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
        const close = 50_000 * (1 + drift) ** index * (1 + Math.sin(index / 7.2) * 0.09);
        const spread = 1 + Math.abs(Math.sin(index / 2.3)) * 0.02;

        candles.push({
            timestamp: newestOpen - (count - 1 - index) * DAY,
            open: close,
            high: close * spread,
            low: close / spread,
            close,
            volume: 1000 + index,
        });
    }

    return candles;
}

describe('a decision cannot see the bar that will produce it', () => {
    it('produces identical decisions when the future is rewritten', () => {
        const candles = series(400);
        const cut = 350;

        for (const strategy of CANDIDATE_STRATEGIES) {
            const before = Array.from(
                { length: cut - strategy.warmup },
                (_, i) => strategy.decide({ candles, index: strategy.warmup + i, series: buildSeries(candles) }),
            );

            // The future is replaced, not appended to. Rewriting it is what a
            // shuffled or partially-loaded dataset looks like, and it is the
            // failure this project has shipped once already.
            const rewritten = [
                ...candles.slice(0, cut),
                ...series(50, -0.05),
            ];
            const rewrittenSeries = buildSeries(rewritten);
            const after = Array.from(
                { length: cut - strategy.warmup },
                (_, i) => strategy.decide({ candles: rewritten, index: strategy.warmup + i, series: rewrittenSeries }),
            );

            expect(after).toEqual(before);
        }
    });

    it('changes when a bar before the decision is rewritten', () => {
        // The control for the test above, and the only thing that makes it
        // mean anything. Without it, "nothing changed when the future was
        // rewritten" is also satisfied by a rule that ignores its input.
        const candles = series(400);
        const strategy = CANDIDATE_STRATEGIES.find(
            (candidate) => candidate.name === 'ema-crossover-20-50',
        )!;

        const read = (source: Candle[]) =>
            Array.from({ length: 60 }, (_, i) =>
                strategy.decide({
                    candles: source,
                    index: 120 + i,
                    series: buildSeries(source),
                }),
            );

        const before = read(candles);
        const tampered = [...candles];

        // A deep drop in the bars the fast average is built from, which is
        // exactly the kind of rewrite that must move the answer.
        for (let index = 100; index < 120; index += 1) {
            tampered[index] = { ...tampered[index]!, close: tampered[index]!.close * 0.6 };
        }

        expect(read(tampered)).not.toEqual(before);
    });
    it('every strategy produces trades on a series that swings', () => {
        const candles = series(600);

        for (const strategy of CANDIDATE_STRATEGIES) {
            const run = runStrategy(strategy, candles);

            // A rule that never fires reports a flat line, which reads as a
            // result rather than as a strategy that did nothing.
            expect(run.metrics.trades, strategy.name).toBeGreaterThan(0);
        }
    });
    it('is deterministic for the same candles', () => {
        const candles = series(400);

        for (const strategy of CANDIDATE_STRATEGIES) {
            expect(runStrategy(strategy, candles).metrics.totalReturn).toBe(
                runStrategy(strategy, candles).metrics.totalReturn,
            );
        }
    });

    it('pays costs, and reports the same benchmark for every rule', () => {
        const candles = series(500);
        const benchmarks = CANDIDATE_STRATEGIES.map(
            (strategy) => runStrategy(strategy, candles).benchmarks.randomEntry,
        );

        // A benchmark that changes down the column is measuring the start date,
        // and cannot be used to compare two rules in it.
        expect(new Set(benchmarks).size).toBe(1);
    });
});

describe('the bench and the running system are the same rule', () => {
    const modules: [string, StrategyModule][] = [
        ['donchian-20', createDonchian()],
        ['donchian-trend-gated', createDonchianTrendGated()],
    ];

    it('agrees with the production module on every bar', () => {
        // The invariant that would have caught the one-bar channel drift before
        // it changed a recommendation. The bench used to carry its own copy of
        // each rule, and the copies were one bar apart — which moved the
        // recommended strategy from +23.96% to -13.31% when the drift was found
        // by making both sides share one implementation.
        const candles = series(300);
        const indicators = buildSeries(candles);

        for (const [label, module] of modules) {
            const candidate = CANDIDATE_STRATEGIES.find(
                (entry) => entry.name === label,
            )!;

            for (let index = module.warmup; index < candles.length; index += 1) {
                const visible = candles.slice(0, index + 1);
                const expected = module.evaluate({
                    candles: visible,
                    price: visible[visible.length - 1]!.close,
                }).direction;
                const actual = candidate.decide({
                    candles,
                    index,
                    series: indicators,
                });

                expect(
                    actual === 1 ? 'LONG' : actual === -1 ? 'SHORT' : 'NEUTRAL',
                    `${label} at bar ${index}`,
                ).toBe(expected);
            }
        }
    });

    it('runs the module rather than restating it', () => {
        // A structural check rather than a behavioural one, because the failure
        // it guards against is reintroducing a hand-written copy. A candidate
        // built by the adapter has to be indistinguishable from the module it
        // wraps, down to the mechanism it publishes.
        const module = createDonchian();
        const adapted = fromModule('donchian-20', module);

        expect(adapted.mechanism).toBe(module.mechanism);
        expect(adapted.warmup).toBe(module.warmup);
    });
});

describe('a fill never lands on the bar whose close asked for it', () => {
    it('enters one bar after the decision, whatever the execution model', () => {
        const candles = series(400);
        const strategy = CANDIDATE_STRATEGIES.find((s) => s.name === 'donchian-20')!;

        for (const model of ['next_open', 'next_close', 'intrabar'] as const) {
            const config = {
                makerFeeRate: 0.0004,
                takerFeeRate: 0.001,
                slippageRate: 0.0005,
                spreadRate: 0.0002,
                liquidity: 'taker',
                model,
            } as const;

            const run = runStrategy(strategy, candles, { execution: config });

            expect(run.metrics.trades).toBeGreaterThan(0);
        }
    });

    it('costs more when the fills are worse', () => {
        const candles = series(500);
        const strategy = CANDIDATE_STRATEGIES.find((s) => s.name === 'ema-crossover-20-50')!;
        const base = {
            makerFeeRate: 0.0004,
            takerFeeRate: 0.001,
            slippageRate: 0.0005,
            spreadRate: 0.0002,
            liquidity: 'taker',
        } as const;

        const cheap = runStrategy(strategy, candles, {
            execution: { ...base, model: 'next_open' },
        });
        const dear = runStrategy(strategy, candles, {
            execution: {
                ...base,
                model: 'intrabar',
                takerFeeRate: 0.004,
                slippageRate: 0.004,
            },
        });

        expect(dear.metrics.totalReturn).toBeLessThan(cheap.metrics.totalReturn);
    });
});
