import { describe, expect, it } from 'vitest';

import { createDonchian } from './donchian.js';
import { createDonchianTrendGated } from './donchian-trend-gated.js';
import { createConsensusPrimary } from './consensus-primary.js';
import {
    createRegistry,
    readFallbackConfig,
    resolveSignal,
} from './registry.js';
import { atrSeries, priorRolling, smaSeries } from './series.js';

import type { Candle } from '../types/market.js';
import type { StrategyDecision, StrategyKey, StrategyModule } from './types.js';

const DAY = 86_400_000;

function series(count: number, drift = 0.0008): Candle[] {
    const newest = Math.floor(Date.now() / DAY) * DAY;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
        const close =
            50_000 * (1 + drift) ** index * (1 + Math.sin(index / 7.2) * 0.09);
        const spread = 1 + Math.abs(Math.sin(index / 2.3)) * 0.02;

        candles.push({
            timestamp: newest - (count - 1 - index) * DAY,
            open: close,
            high: close * spread,
            low: close / spread,
            close,
            volume: 1000 + index,
        });
    }

    return candles;
}

const LONG: StrategyDecision = {
    direction: 'LONG',
    confidence: 80,
    reason: 'консенсус',
    warm: false,
};
const NEUTRAL: StrategyDecision = {
    direction: 'NEUTRAL',
    confidence: 0,
    reason: 'молчит',
    warm: false,
};

const always = (decision: StrategyDecision): StrategyModule => ({
    key: 'donchian-20',
    name: 'test',
    mechanism: 'A mechanism long enough to satisfy the registry, written out in full.',
    warmup: 1,
    evaluate: () => decision,
});

const registryWith = (
    primary: StrategyDecision,
    fallback: StrategyDecision,
    mode: 'shadow' | 'active',
) =>
    createRegistry({
        consensus: () => primary,
        config: { key: 'donchian-20', mode },
        overrides: { 'donchian-20': () => always(fallback) },
    });

describe('the catalogue is one list', () => {
    it('holds every installed strategy and nothing unregistered', () => {
        const registry = createRegistry({ consensus: () => NEUTRAL });

        expect(registry.keys()).toEqual(
            expect.arrayContaining([
                'consensus-primary',
                'donchian-20',
                'donchian-trend-gated',
            ]),
        );
    });

    it('refuses a strategy that cannot say why it should make money', () => {
        // The one rule the registry exists to enforce. An empty mechanism is a
        // rule nobody can reason about when it disappoints.
        expect(() =>
            createRegistry({
                consensus: () => NEUTRAL,
                overrides: {
                    'donchian-20': () => ({
                        ...always(NEUTRAL),
                        mechanism: '',
                    }),
                },
            }),
        ).toThrow(/why it should make money/);
    });

    it('refuses a primary chosen as its own fallback', () => {
        // Otherwise the fallback is a second strategy with equal authority and
        // no way to tell the two apart afterwards.
        expect(() =>
            createRegistry({
                consensus: () => NEUTRAL,
                config: { key: 'consensus-primary', mode: 'active' },
            }),
        ).toThrow(/cannot be the primary/);
    });

    it('refuses a configuration it was not given', () => {
        expect(() => readFallbackConfig({ FALLBACK_STRATEGY: 'nope' })).toThrow(
            /FALLBACK_STRATEGY/,
        );
        expect(() =>
            readFallbackConfig({
                FALLBACK_STRATEGY: 'donchian-20',
                FALLBACK_MODE: 'loud',
            }),
        ).toThrow(/FALLBACK_MODE/);
    });

    it('reads a valid configuration and defaults to shadow', () => {
        expect(readFallbackConfig({})).toEqual({
            key: 'donchian-trend-gated',
            mode: 'shadow',
        });
        expect(
            readFallbackConfig({
                FALLBACK_STRATEGY: 'donchian-20',
                FALLBACK_MODE: 'active',
            }),
        ).toEqual({ key: 'donchian-20', mode: 'active' });
    });
});

describe('a fallback fills a gap and nothing else', () => {
    it('cannot overrule a signal the primary did publish', () => {
        const registry = registryWith(LONG, {
            ...NEUTRAL,
            direction: 'SHORT',
            reason: 'резерв',
        }, 'active');

        const resolved = resolveSignal(registry, {
            candles: series(300),
            price: 50_000,
        });

        expect(resolved.published.direction).toBe('LONG');
        expect(resolved.publishedBy).toBe('consensus-primary');
    });

    it('speaks in the gap when allowed to', () => {
        const registry = registryWith(NEUTRAL, {
            ...NEUTRAL,
            direction: 'SHORT',
            reason: 'резерв',
        }, 'active');

        const resolved = resolveSignal(registry, {
            candles: series(300),
            price: 50_000,
        });

        expect(resolved.published.direction).toBe('SHORT');
        expect(resolved.publishedBy).toBe('donchian-20');
        expect(resolved.suppressed).toBe(false);
    });

    it('is held back, and says so, in shadow mode', () => {
        // The default, and the reason this is safe to ship at all. The rule
        // behind this fallback was chosen by looking at a backtest and has
        // traded no live bar; publishing it on that basis is the mistake the
        // pipeline in this project exists to prevent.
        const registry = registryWith(NEUTRAL, {
            ...NEUTRAL,
            direction: 'SHORT',
            reason: 'резерв',
        }, 'shadow');

        const resolved = resolveSignal(registry, {
            candles: series(300),
            price: 50_000,
        });

        expect(resolved.published.direction).toBe('NEUTRAL');
        expect(resolved.publishedBy).toBe('consensus-primary');
        // Still evaluated, and the disagreement reported: that is the live
        // evidence the shadow period exists to collect.
        expect(resolved.fallbackDecision?.direction).toBe('SHORT');
        expect(resolved.suppressed).toBe(true);
    });

    it('is evaluated even when the primary spoke, or the shadow learns nothing', () => {
        // Only recording the cases where it was already irrelevant would omit
        // exactly the disagreements, which are the informative ones.
        const registry = registryWith(LONG, {
            ...NEUTRAL,
            direction: 'SHORT',
        }, 'shadow');

        const resolved = resolveSignal(registry, {
            candles: series(300),
            price: 50_000,
        });

        expect(resolved.fallbackDecision?.direction).toBe('SHORT');
    });

    it('reports no suppression when there was nothing to suppress', () => {
        const registry = registryWith(NEUTRAL, NEUTRAL, 'shadow');

        const resolved = resolveSignal(registry, {
            candles: series(300),
            price: 50_000,
        });

        expect(resolved.suppressed).toBe(false);
    });
});

describe('a module cannot see the future', () => {
    const modules: StrategyKey[] = ['donchian-20', 'donchian-trend-gated'];
    const build = (key: StrategyKey): StrategyModule =>
        key === 'donchian-20' ? createDonchian() : createDonchianTrendGated();

    it('ignores bars appended after the decision point', () => {
        for (const key of modules) {
            const module = build(key);
            const candles = series(400);
            const read = (source: Candle[]) =>
                Array.from({ length: 40 }, (_, i) => {
                    const cut = 300 + i;

                    return module.evaluate({
                        candles: source.slice(0, cut),
                        price: source[cut - 1]!.close,
                    }).direction;
                });

            const before = read(candles);
            // A hundred bars of different future. A module that read past the
            // end of what it was given would answer differently, and the only
            // way to know is to hand it a different future.
            const rewritten = [
                ...candles,
                ...series(100, -0.04).map((bar, i) => ({ ...bar, timestamp: bar.timestamp + i * DAY })),
            ];

            expect(read(rewritten), key).toEqual(before);
        }
    });

    it('changes when a bar inside the window is rewritten', () => {
        // The control. Without it the test above would also be satisfied by a
        // module that ignores its input entirely — and it is easy to write one
        // that looks like it works, because a stretch with no breakout in it
        // answers NEUTRAL whatever you do to it.
        const module = createDonchian();
        const candles = series(400);
        const decide = (source: Candle[], cut: number) =>
            module.evaluate({
                candles: source.slice(0, cut),
                price: source[cut - 1]!.close,
            }).direction;

        // A bar the rule actually has an opinion about.
        const decided = candles.findIndex(
            (_, cut) => cut > 60 && decide(candles, cut) !== 'NEUTRAL',
        );

        expect(decided, 'no breakout anywhere in the fixture').toBeGreaterThan(60);

        const original = decide(candles, decided);
        const tampered = [...candles];

        // The whole window, flattened outward: the floor collapses and the
        // ceiling goes up, so neither channel can be broken. Both channels
        // move, so the verdict moves whatever side it was on — raising one
        // extreme only ever disturbs one of the two, and a control that depends
        // on which side the fixture happened to break out is not a control.
        //
        // Direction matters. Lifting the lows *would* have kept a SHORT alive
        // and then forever, since a close under an unreachable floor is still a
        // close under it.
        for (let index = decided - 20; index < decided; index += 1) {
            tampered[index] = {
                ...tampered[index]!,
                high: 1e9,
                low: 0,
            };
        }

        expect(decide(tampered, decided)).not.toBe(original);
    });
});

describe('the warmup is reported, not hidden inside NEUTRAL', () => {
    it('says it has not warmed up rather than pretending to have no opinion', () => {
        // Two different situations with two different consequences. A strategy
        // that has to flatten them into one has to decide which to lie about.
        for (const module of [createDonchian(), createDonchianTrendGated()]) {
            const decision = module.evaluate({
                candles: series(5),
                price: 50_000,
            });

            expect(decision.direction).toBe('NEUTRAL');
            expect(decision.warm, module.key).toBe(true);
        }
    });

    it('stops being warm once it has the history it asked for', () => {
        for (const module of [createDonchian(), createDonchianTrendGated()]) {
            const decision = module.evaluate({
                candles: series(module.warmup + 20),
                price: 50_000,
            });

            expect(decision.warm, module.key).toBe(false);
        }
    });
});

describe('the primary is the running system, unchanged', () => {
    it('hands the consensus the closes its confirmation needs', () => {
        const seen: number[][] = [];
        const module = createConsensusPrimary(
            (price, closes) => {
                seen.push([...closes]);

                return LONG;
            },
            { emaConfirmBars: 3 },
        );

        module.evaluate({ candles: series(200), price: 1 });

        // confirmBars + 1 closes, because a confirmation compares the last one
        // against the ones before it. One short would be a more trigger-happy
        // confirmation than every other signal was produced with.
        expect(seen[0]).toHaveLength(4);
    });

    it('does not compute a vote it has too few closes for', () => {
        // Before the call, not after. The first version of this adapter called
        // first and checked afterwards, which produced a shorter confirmation
        // than the rest of the system uses.
        let called = 0;
        const module = createConsensusPrimary(
            () => {
                called += 1;

                return LONG;
            },
            { emaConfirmBars: 10 },
        );

        const decision = module.evaluate({ candles: series(5), price: 1 });

        expect(called).toBe(0);
        expect(decision.warm).toBe(true);
    });
});

describe('the series the strategies share', () => {
    it('measures a channel against the bars before, not the bar itself', () => {
        const candles = series(100);
        const highs = candles.map((candle) => candle.high);
        const channel = priorRolling(highs, 20, 'max');

        // Exactly the twenty bars before the one being measured. A channel that
        // included the current bar could never be broken, and the earlier bench
        // measured against two such windows, which is a different strategy.
        for (let index = 20; index < candles.length; index += 1) {
            const expected = Math.max(...highs.slice(index - 20, index));

            expect(channel[index]!).toBeCloseTo(expected, 9);
        }

        // And the first usable index has no channel at all, rather than a
        // window shorter than the one the rule was written for.
        expect(Number.isNaN(channel[0]!)).toBe(true);
    });

    it('recovers from a leading undefined region', () => {
        // A running sum takes the first NaN and stays NaN forever, so a series
        // averaged from another indicator with a longer warmup would be
        // undefined everywhere and any rule gated on it would never fire.
        const atr = atrSeries(series(300), 14);
        const slow = smaSeries(atr, 40);

        expect(Number.isFinite(slow[slow.length - 1]!)).toBe(true);
    });

    it('leaves the warmup undefined rather than guessing', () => {
        const atr = atrSeries(series(300), 14);

        expect(Number.isNaN(atr[0]!)).toBe(true);
        expect(Number.isFinite(atr[13]!)).toBe(true);
    });
});
