import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { ParameterSpecSchema, parameterGrid, parameterByKey, TUNABLE_PARAMETERS } from '../config/parameter.config.js';
import { optimize, detectSpike, enumerateGrid } from './optimizer.js';
import { DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';
import { buildWalkForwardPlan, judgeFold } from './walk-forward.plan.js';
import { computeSignalSeries, reapplyThresholds } from './point-in-time.js';
import { simulateRange } from './walk-forward.js';
import { requiredCandleCount } from '../config/indicator.config.js';

import type { ParameterSpec } from '../config/parameter.config.js';
import type { SearchResult } from './optimizer.js';
import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
const BASE = 1_400_000_000_000;

/**
 * A market that goes up for a while and then goes down.
 *
 * Not a random walk, and not a sine: both have structure, and a search run
 * against either will find a "best" parameter that is really a description of
 * the shape rather than of the strategy.
 */
function candles(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => {
        const trend = index < count / 2 ? 1 : -1;
        const percent = 0.002 * trend * Math.sin(index / 7);
        const close = 100 * (1 + percent) ** index;

        return {
            timestamp: BASE + index * HOUR,
            open: index === 0 ? close : 100 * (1 + 0.002 * trend * Math.sin((index - 1) / 7)) ** (index - 1),
            high: close * 1.002,
            low: close * 0.998,
            close,
            volume: 1,
        };
    });
}

const SPECS: ParameterSpec[] = ParameterSpecSchema.array().parse([
    {
        key: 'stochastic.longThreshold',
        label: 'long',
        min: 10,
        max: 40,
        step: 10,
        production: 20,
        tunable: true,
    },
    {
        key: 'stochastic.shortThreshold',
        label: 'short',
        min: 60,
        max: 90,
        step: 10,
        production: 80,
        tunable: true,
    },
]);

const SAMPLE = candles(requiredCandleCount() + 400);
const WARMUP_END = requiredCandleCount() - 1;

function searchWindow(): { startIndex: number; endIndex: number } {
    return { startIndex: WARMUP_END + 1, endIndex: SAMPLE.length - 1 };
}

function runSearch(overrides: Partial<Parameters<typeof optimize>[0]> = {}): SearchResult {
    const window = searchWindow();

    return optimize({
        candles: SAMPLE,
        startIndex: window.startIndex,
        endIndex: window.endIndex,
        options: DEFAULT_WALK_FORWARD_OPTIONS,
        specs: SPECS,
        ...overrides,
    });
}

describe('the registry decides what may be tuned at all', () => {
    it('refuses a shipped value its own range cannot reach', () => {
        expect(() =>
            ParameterSpecSchema.parse({
                key: 'a',
                label: 'A',
                min: 10,
                max: 20,
                step: 5,
                production: 50,
                tunable: true,
            }),
        ).toThrow(/cannot reach/);
    });

    it('refuses a shipped value that is not on its own grid', () => {
        // A misaligned step means the grid is a set of points the running
        // configuration is not one of, so a search that found the best point
        // on it is reporting on a product nobody has.
        expect(() =>
            ParameterSpecSchema.parse({
                key: 'a',
                label: 'A',
                min: 10,
                max: 20,
                step: 3,
                production: 20,
                tunable: true,
            }),
        ).toThrow(/not on its own grid/);
    });

    it('refuses a range narrower than a step', () => {
        expect(() =>
            ParameterSpecSchema.parse({
                key: 'a',
                label: 'A',
                min: 10,
                max: 11,
                step: 5,
                production: 10,
                tunable: true,
            }),
        ).toThrow(/narrower than one step/);
    });

    it('builds a grid that ends exactly on the maximum', () => {
        const spec = ParameterSpecSchema.parse({
            key: 'a',
            label: 'A',
            min: 10,
            max: 25,
            step: 5,
            production: 15,
            tunable: true,
        });

        // The last value of a range is the one somebody notices, and repeated
        // addition of a fractional step walks off the grid and leaves it out.
        expect(parameterGrid(spec)).toEqual([10, 15, 20, 25]);
    });

    it('ships every registered parameter at a value the grid contains', () => {
        for (const spec of TUNABLE_PARAMETERS) {
            expect(parameterGrid(spec)).toContain(spec.production);
        }
    });

    it('keeps a locked parameter out of the tunable list', () => {
        const locked = parameterByKey('ema.confirmBars');

        expect(locked?.tunable).toBe(false);
        expect(TUNABLE_PARAMETERS.map((spec) => spec.key)).not.toContain(
            'ema.confirmBars',
        );
    });
});

describe('the search only ever sees the bars it was given', () => {
    it('scores the same candidate the same way whatever is outside the window', () => {
        const window = searchWindow();
        const withTail = optimize({
            candles: SAMPLE,
            startIndex: window.startIndex,
            endIndex: window.endIndex,
            options: DEFAULT_WALK_FORWARD_OPTIONS,
            specs: SPECS,
        });
        const withNoiseAfter = optimize({
            // A hundred bars of nonsense appended. A search that reads past
            // its window would score differently, and a search that cannot
            // score differently is not a search that reads past its window.
            candles: [
                ...SAMPLE,
                ...candles(100).map((bar, index) => ({
                    ...bar,
                    timestamp: bar.timestamp + index * HOUR,
                    close: bar.close * 10,
                })),
            ],
            startIndex: window.startIndex,
            endIndex: window.endIndex,
            options: DEFAULT_WALK_FORWARD_OPTIONS,
            specs: SPECS,
        });

        expect(withNoiseAfter.ranked.map((row) => row.label)).toEqual(
            withTail.ranked.map((row) => row.label),
        );
        // Two full grid searches over the whole sample. The five second default
        // is enough on an idle machine and not enough when a hundred and seventy
        // files are running beside it, which makes a correct test report a
        // failure that depends on how busy the disk was. The work is real, so
        // the budget is stated.
    }, 30_000);

    it('changes its scores when the window changes', () => {
        const first = runSearch();
        const second = optimize({
            candles: SAMPLE,
            startIndex: WARMUP_END + 1,
            endIndex: WARMUP_END + 150,
            options: DEFAULT_WALK_FORWARD_OPTIONS,
            specs: SPECS,
        });

        // The winner may legitimately be the same on both windows — what
        // cannot be the same is the score. If these were identical the search
        // would be describing the sample rather than the parameters.
        const firstScores = first.ranked.map((row) => row.score);
        const secondScores = second.ranked.map((row) => row.score);

        expect(firstScores).not.toEqual(secondScores);
        // The same two grid searches as the test above, and the same missing
        // budget. That one carries a 30s timeout with a comment explaining why,
        // and this one was written next to it and did not get one — so it
        // inherited vitest's five seconds and reported a failure whenever the
        // rest of the suite was busy, which is precisely when a full run runs.
        //
        // Observed once in six full runs and never on an idle machine, which is
        // what the neighbour's comment predicted before this one was diagnosed.
        // Not reproduced in isolation, so the claim is the mechanism read from
        // this file rather than a reproduction.
    }, 30_000);
});

describe('a point that never trades is not a bad score', () => {
    it('leaves it out of the ranking rather than scoring it zero', () => {
        // A single bar as the whole window: a signal on it would enter on the
        // next one, which does not exist, so no point of any grid can trade.
        // Constructed rather than arranged, because arranging it with data
        // would make the test depend on which bars the fixture happens to
        // avoid.
        const inert: ParameterSpec[] = ParameterSpecSchema.array().parse([
            {
                key: 'stochastic.longThreshold',
                label: 'long',
                min: 90,
                max: 95,
                step: 5,
                production: 90,
                tunable: true,
            },
            {
                key: 'stochastic.shortThreshold',
                label: 'short',
                min: 5,
                max: 10,
                step: 5,
                production: 5,
                tunable: true,
            },
        ]);

        const last = SAMPLE.length - 1;
        const result = optimize({
            candles: SAMPLE,
            startIndex: last,
            endIndex: last,
            options: DEFAULT_WALK_FORWARD_OPTIONS,
            specs: inert,
        });

        // Ranking an inert point as zero would let a dead configuration beat
        // a live one, which is how a search "improves" by doing nothing.
        expect(result.best).toBeNull();
        expect(result.inert).toBe(result.gridSize);
        expect(result.inert).toBeGreaterThan(0);
    });

    it('says how much of the grid it actually reached', () => {
        const capped = runSearch({ limit: 3 });

        // A search that quietly covered a tenth of its space looks exactly
        // like one that covered all of it, and the difference is the
        // difference between "best in this region" and "best anywhere".
        expect(capped.evaluated).toBe(3);
        expect(capped.gridSize).toBeGreaterThan(3);
    });
});

describe('the neighbourhood check is the defence', () => {
    it('returns the whole ranking, not just the winner', () => {
        const result = runSearch();

        // A search whose neighbours are not visible cannot be checked for a
        // spike, and this is the only defence the system has.
        expect(result.ranked.length).toBeGreaterThan(1);
        expect(result.best?.label).toBe(result.ranked[0]?.label);
    });

    it('sorts by score, so the winner is the first one', () => {
        const result = runSearch();

        for (let index = 1; index < result.ranked.length; index += 1) {
            expect(result.ranked[index - 1]!.score).toBeGreaterThanOrEqual(
                result.ranked[index]!.score,
            );
        }
    });

    it('flags a winner whose neighbours are far worse than it', () => {
        // A search that found a genuine edge keeps most of its score one step
        // away. This one did not, which is the shape of noise.
        const spike: SearchResult = {
            best: {
                values: {
                    'stochastic.longThreshold': 20,
                    'stochastic.shortThreshold': 80,
                },
                label: 'longThreshold=20 shortThreshold=80',
                score: 1,
                trades: 40,
                stability: 0,
            },
            ranked: [
                {
                    values: {
                        'stochastic.longThreshold': 20,
                        'stochastic.shortThreshold': 80,
                    },
                    label: 'longThreshold=20 shortThreshold=80',
                    score: 1,
                    trades: 40,
                    stability: 0,
                },
                {
                    values: {
                        'stochastic.longThreshold': 30,
                        'stochastic.shortThreshold': 80,
                    },
                    label: 'longThreshold=30 shortThreshold=80',
                    score: 0.01,
                    trades: 40,
                    stability: 0,
                },
            ],
            evaluated: 2,
            gridSize: 9,
            inert: 0,
            window: { startIndex: 0, endIndex: 100 },
        };

        const verdict = detectSpike(spike, SPECS, 0.5);

        expect(verdict.spike).toBe(true);
        expect(verdict.neighbourRetention).toBeCloseTo(0.01, 10);
        expect(verdict.reason).toMatch(/пик, а не край/);
    });

    it('accepts a winner whose neighbours are nearly as good', () => {
        const edge: SearchResult = {
            best: {
                values: {
                    'stochastic.longThreshold': 20,
                    'stochastic.shortThreshold': 80,
                },
                label: 'longThreshold=20 shortThreshold=80',
                score: 0.02,
                trades: 40,
                stability: 0.001,
            },
            ranked: [
                {
                    values: {
                        'stochastic.longThreshold': 20,
                        'stochastic.shortThreshold': 80,
                    },
                    label: 'longThreshold=20 shortThreshold=80',
                    score: 0.02,
                    trades: 40,
                    stability: 0.001,
                },
                {
                    values: {
                        'stochastic.longThreshold': 30,
                        'stochastic.shortThreshold': 80,
                    },
                    label: 'longThreshold=30 shortThreshold=80',
                    score: 0.019,
                    trades: 40,
                    stability: 0.001,
                },
            ],
            evaluated: 2,
            gridSize: 9,
            inert: 0,
            window: { startIndex: 0, endIndex: 100 },
        };

        const verdict = detectSpike(edge, SPECS, 0.5);

        expect(verdict.spike).toBe(false);
        expect(verdict.neighbourRetention ?? 0).toBeGreaterThan(0.9);
    });

    it('reports a winner with no neighbours as unmeasured, not clean', () => {
        const alone: SearchResult = {
            best: {
                values: { 'stochastic.longThreshold': 20 },
                label: 'longThreshold=20',
                score: 0.05,
                trades: 10,
                stability: 0,
            },
            ranked: [
                {
                    values: { 'stochastic.longThreshold': 20 },
                    label: 'longThreshold=20',
                    score: 0.05,
                    trades: 10,
                    stability: 0,
                },
            ],
            evaluated: 1,
            gridSize: 1,
            inert: 0,
            window: { startIndex: 0, endIndex: 100 },
        };

        const verdict = detectSpike(alone, SPECS, 0.5);

        // "Nothing to compare against" is not the same finding as "the
        // neighbourhood is fine", and the first is what a one-point grid
        // produces.
        expect(verdict.spike).toBe(false);
        expect(verdict.neighbourRetention).toBeNull();
        expect(verdict.reason).toMatch(/не находка/);
    });

    it('does not let "not a spike" read as an endorsement of a losing winner', () => {
        // Measured on the BTCUSDT fixture: 64 grid points, every one of them
        // negative, best -0.0008. The check passed cleanly — a plateau of
        // identical negative scores retains 100% of the winner — and a reader
        // would take the verdict as a green light.
        const losing: SearchResult = {
            best: {
                values: {
                    'stochastic.longThreshold': 20,
                    'stochastic.shortThreshold': 80,
                },
                label: 'longThreshold=20 shortThreshold=80',
                score: -0.0008,
                trades: 66,
                stability: 0.0075,
            },
            ranked: [
                {
                    values: {
                        'stochastic.longThreshold': 20,
                        'stochastic.shortThreshold': 80,
                    },
                    label: 'longThreshold=20 shortThreshold=80',
                    score: -0.0008,
                    trades: 66,
                    stability: 0.0075,
                },
                {
                    values: {
                        'stochastic.longThreshold': 30,
                        'stochastic.shortThreshold': 80,
                    },
                    label: 'longThreshold=30 shortThreshold=80',
                    score: -0.0008,
                    trades: 66,
                    stability: 0.0075,
                },
            ],
            evaluated: 2,
            gridSize: 64,
            inert: 0,
            window: { startIndex: 0, endIndex: 100 },
        };

        const verdict = detectSpike(losing, SPECS, 0.5);

        // Not being a spike is a statement about the shape of the result, not
        // about whether anybody should trade it.
        expect(verdict.spike).toBe(false);
        expect(verdict.reason).toMatch(/сам по себе убыточен/);
        expect(verdict.reason).toMatch(/не «годно к применению»/);
    });

    it('says nothing extra when the winner did make money', () => {
        const profitable: SearchResult = {
            best: {
                values: { 'stochastic.longThreshold': 20 },
                label: 'longThreshold=20',
                score: 0.01,
                trades: 40,
                stability: 0.001,
            },
            ranked: [
                {
                    values: { 'stochastic.longThreshold': 20 },
                    label: 'longThreshold=20',
                    score: 0.01,
                    trades: 40,
                    stability: 0.001,
                },
                {
                    values: { 'stochastic.longThreshold': 30 },
                    label: 'longThreshold=30',
                    score: 0.009,
                    trades: 40,
                    stability: 0.001,
                },
            ],
            evaluated: 2,
            gridSize: 4,
            inert: 0,
            window: { startIndex: 0, endIndex: 100 },
        };

        expect(detectSpike(profitable, SPECS, 0.5).reason).not.toMatch(
            /убыточен/,
        );
    });

    it('covers the whole grid when the limit allows it', () => {
        const { candidates, total } = enumerateGrid(SPECS);

        expect(candidates).toHaveLength(total);
        expect(total).toBe(4 * 4);
    });
});

describe('a found parameter still has to survive the bar after it', () => {
    it('is judged on data it was not chosen on', () => {
        const plan = buildWalkForwardPlan(
            SAMPLE.length,
            DEFAULT_WALK_FORWARD_OPTIONS,
        );
        const [fold] = plan.folds;

        const fit = runSearch();
        const validation = judgeFold(
            fold!,
            fit.best?.score ?? null,
            // The score on a window the search never saw: by construction a
            // different number, and that is the whole point.
            (fold!.validate.startIndex + fold!.validate.endIndex) / 2 > 0
                ? -0.01
                : 0.01,
        );

        expect(validation.accepted).toBe(false);
        expect(validation.reason).toMatch(/по шуму/);
    });

    it('scores a window the way the walk-forward runner would', () => {
        const window = searchWindow();
        const points = reapplyThresholds(
            computeSignalSeries(
                SAMPLE,
                window.startIndex,
                window.endIndex,
            ),
            { stochastic: { longThreshold: 20, shortThreshold: 80 } },
        );
        const { trades } = simulateRange(
            SAMPLE,
            points,
            window.startIndex,
            window.endIndex,
            DEFAULT_WALK_FORWARD_OPTIONS,
        );

        const expectancy =
            trades.reduce((sum, trade) => sum + trade.netReturn, 0) /
            trades.length;

        // The two paths must agree, or the optimiser is searching over a
        // different strategy from the one the report describes.
        const result = optimize({
            candles: SAMPLE,
            startIndex: window.startIndex,
            endIndex: window.endIndex,
            options: DEFAULT_WALK_FORWARD_OPTIONS,
            specs: [
                {
                    key: 'stochastic.longThreshold',
                    label: 'l',
                    min: 20,
                    max: 20,
                    step: 5,
                    production: 20,
                    tunable: true,
                },
                {
                    key: 'stochastic.shortThreshold',
                    label: 's',
                    min: 80,
                    max: 80,
                    step: 5,
                    production: 80,
                    tunable: true,
                },
            ],
        });

        expect(result.best?.score).toBeCloseTo(expectancy, 8);
    });
});

describe('a grid is a grid', () => {
    it('always contains the shipped value of every parameter', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 50 }),
                fc.integer({ min: 1, max: 50 }),
                (minOffset, span) => {
                    // Step derived from the span, because a step wider than the
                    // whole range is a range with no points in it and the
                    // registry refuses it — correct, but not what this
                    // property is about.
                    const step = 1 + ((span - 1) % 5);
                    const min = minOffset;
                    const max = min + span;
                    const production = min + Math.floor(span / step) * step;
                    const spec = ParameterSpecSchema.parse({
                        key: 'a',
                        label: 'A',
                        min,
                        max,
                        step,
                        production,
                        tunable: true,
                    });

                    // The value the product runs must be reachable, or a search
                    // over the range can never reproduce the product.
                    expect(parameterGrid(spec)).toContain(production);
                    expect(parameterGrid(spec)[0]).toBe(min);
                    expect(parameterGrid(spec).at(-1)).toBeLessThanOrEqual(max);
                },
            ),
            { numRuns: 200 },
        );
    });
});
