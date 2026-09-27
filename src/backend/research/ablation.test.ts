import { describe, expect, it } from 'vitest';

import { buildSeries, CANDIDATE_STRATEGIES, runStrategy, fromModule } from './strategies.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';

import type { Decision, Strategy } from './strategies.js';
import type { Candle } from '../types/market.js';

const DAY = 86_400_000;

function series(count: number, drift = 0.0008): Candle[] {
    const newestOpen = Math.floor(Date.now() / DAY) * DAY;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
        const close =
            50_000 * (1 + drift) ** index * (1 + Math.sin(index / 7.2) * 0.09);
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

const at = (values: readonly number[], index: number): number =>
    values[index] ?? NaN;

const ready = (...values: number[]): boolean =>
    values.every((value) => Number.isFinite(value));

function breakout(context: {
    candles: readonly Candle[];
    index: number;
    series: Readonly<Record<string, readonly number[]>>;
}): Decision {
    const { candles, index, series } = context;
    const high = at(series['high20p1']!, index);
    const low = at(series['low20p1']!, index);

    if (!ready(high, low)) {
        return 0;
    }

    return candles[index]!.close > high ? 1 : candles[index]!.close < low ? -1 : 0;
}

function volatilityHigh(context: {
    index: number;
    series: Readonly<Record<string, readonly number[]>>;
}): boolean {
    const atr = at(context.series['atr']!, context.index);
    const slow = at(context.series['atrSlow']!, context.index);

    return ready(atr, slow) && atr > slow;
}

const make = (name: string, decide: Strategy['decide']): Strategy => ({
    name,
    mechanism: 'ablation component',
    warmup: 60,
    decide,
});

const GATED = make('gated', (context) =>
    volatilityHigh(context) ? breakout(context) : 0,
);
const INVERTED = make('inverted', (context) =>
    volatilityHigh(context) ? 0 : breakout(context),
);
const GATE_ONLY = make('gate-only', (context) =>
    volatilityHigh(context) ? 1 : 0,
);
const BREAKOUT_ONLY = make('breakout-only', breakout);

describe('what the chosen rule is actually made of', () => {
    it('the gate selects only about half of what it is given', () => {
        // The load-bearing fact behind every conclusion about this rule. A
        // filter that passes 55% of breakouts is barely a filter, and calling
        // it one is what makes its result look like skill.
        const candles = series(900);
        const indicators = buildSeries(candles);

        let breakouts = 0;
        let kept = 0;
        let barsTrue = 0;
        let barsConsidered = 0;

        for (let index = 60; index < candles.length; index += 1) {
            const high = Number.isFinite(indicators['atr']![index]!) &&
                Number.isFinite(indicators['atrSlow']![index]!);

            if (high) {
                barsConsidered += 1;

                if (volatilityHigh({ index, series: indicators })) {
                    barsTrue += 1;
                }
            }

            if (breakout({ candles, index, series: indicators }) === 0) {
                continue;
            }

            breakouts += 1;

            if (volatilityHigh({ index, series: indicators })) {
                kept += 1;
            }
        }

        const share = kept / breakouts;

        expect(breakouts).toBeGreaterThan(20);
        expect(share).toBeGreaterThan(0.15);
        expect(share).toBeLessThan(0.85);
        expect(barsTrue / barsConsidered).toBeGreaterThan(0.3);
        expect(barsTrue / barsConsidered).toBeLessThan(0.7);
    });

    it('inverting the gate changes the trades, so the control means something', () => {
        const candles = series(900);

        const normal = runStrategy(GATED, candles).metrics.trades;
        const inverted = runStrategy(INVERTED, candles).metrics.trades;

        // If these were equal the two rules would be the same rule and every
        // comparison between them in the report would be an artefact.
        expect(normal).not.toBe(inverted);
        expect(normal + inverted).toBeGreaterThan(0);
    });

    it('the gate alone keeps more of the market than the gate with the breakout', () => {
        const candles = series(900);

        const gate = runStrategy(GATE_ONLY, candles);
        const combined = runStrategy(GATED, candles);
        const breakoutOnly = runStrategy(BREAKOUT_ONLY, candles);

        // The breakout is what makes the rule selective; the gate alone is
        // nearly always in the market. This is the structural reason the two
        // halves of the rule behave like different strategies.
        expect(gate.metrics.exposure).toBeGreaterThan(combined.metrics.exposure);
        expect(combined.metrics.exposure).toBeLessThan(breakoutOnly.metrics.exposure);
    });

    it('removing the breakout and keeping the gate is not the same strategy', () => {
        const candles = series(900);
        const combined = runStrategy(GATED, candles);
        const gate = runStrategy(GATE_ONLY, candles);

        // Asserting they are equal would be asserting the opposite of what the
        // measurement found, and a strategy that only exists as the sum of its
        // parts is a strategy nobody can repair when it breaks.
        expect(combined.metrics.trades).not.toBe(gate.metrics.trades);
    });
});

describe('the recommended rule is the one this project ships', () => {
    it('matches the module the server actually runs', () => {
        // The ablation variants are local reimplementations, written to take
        // the rule apart. They exist to disagree with each other, not to stand
        // in for production — and this is what stops that from becoming a
        // silent second copy of the rule.
        //
        // Warmup is taken from each side rather than hardcoded, because the
        // number that made this pass by accident was a literal 60 in the test
        // against the module's own 55.
        const chosen = CANDIDATE_STRATEGIES.find(
            (candidate) => candidate.name === 'donchian-trend-gated',
        )!;
        const module = createDonchianTrendGated();
        const candles = series(900);

        expect(chosen.mechanism).toBe(module.mechanism);

        // Re-adapting the real module and running it must reproduce the bench
        // candidate exactly, because that is now the only way the bench obtains
        // a rule that has a module.
        expect(runStrategy(fromModule('donchian-trend-gated', module), candles)
            .metrics.trades).toBe(runStrategy(chosen, candles).metrics.trades);
    });
});
