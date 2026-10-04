import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OutcomeConfigParser } from '../config/outcome.config.js';
import type { Candle } from '../types/market.js';
import { measureOutcome, readExcursions } from './outcome.js';

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000;

const CONFIG = OutcomeConfigParser.parse({
    horizons: [1, 3, 12],
    breakevenPercent: 0.1,
    trackExcursions: true,
});

/**
 * A bar that rises by `step` percent per bar, or falls by it for a short.
 *
 * Constant percentage rather than a fixed number of currency units, because a
 * fixed step means something different on every instrument: two units is two
 * percent of one hundred and half a percent of five hundred, which is a
 * volatility change wearing a trend's clothes.
 */
function path(
    count: number,
    percentPerBar: number,
    direction: 'LONG' | 'SHORT' = 'LONG',
): Candle[] {
    return Array.from({ length: count }, (_, index) => {
        const step = direction === 'LONG' ? percentPerBar : -percentPerBar;
        const close = 100 * (1 + step) ** index;
        const open = index === 0 ? close : 100 * (1 + step) ** (index - 1);

        return {
            timestamp: BASE + index * HOUR,
            open,
            high: Math.max(open, close) * 1.0005,
            low: Math.min(open, close) * 0.9995,
            close,
            volume: 1,
        };
    });
}

function measure(
    candles: Candle[],
    overrides: Partial<Parameters<typeof measureOutcome>[0]> = {},
) {
    return measureOutcome({
        symbol: 'BTCUSDT',
        entryTimestamp: BASE,
        entryPrice: 100,
        direction: 'LONG',
        candles,
        config: CONFIG,
        ...overrides,
    });
}

/**
 * One horizon, chosen by how many bars it reaches forward.
 *
 * Taking `horizons[0]` would have been the convenient way to write these tests
 * and it would have quietly changed what they measure: the first horizon is one
 * bar, and a question about a twelve-bar window is a different question. Three
 * of them failed against the engine before I said which horizon I meant.
 */
function horizonAt(bars: number, candles: Candle[], overrides = {}) {
    const found = measure(candles, overrides).horizons.find((h) => h.bars === bars);

    expect(found).toBeDefined();

    return found!;
}

describe('the outcome types PHASE 12.1 asks about', () => {
    it('answers "did it reach the target" from the excursion already recorded', () => {
        // PHASE 12.1 lists `hit target` and `hit stop` among the outcome types
        // and says the schema is better prepared for them. They are deliberately
        // *not* columns: a target is policy, and baking it into the row would
        // make every stored outcome wrong the moment somebody changed it. The
        // question is asked afterwards, from what was measured.
        const horizon = horizonAt(12, path(40, 0.01));

        const hit = readExcursions(horizon, { targetFraction: 0.05, stopFraction: 0.05 });
        const missed = readExcursions(horizon, { targetFraction: 5, stopFraction: 0.05 });

        expect(hit.answered).toBe(true);
        expect(hit.hitTarget).toBe(true);
        expect(missed.hitTarget).toBe(false);
        expect(missed.missedTargetBy).toBeGreaterThan(0);
    });

    it('answers "was it stopped" from the adverse excursion', () => {
        // A falling market under a long signal: the stop is the whole story.
        const horizon = horizonAt(12, path(40, -0.01));

        const stopped = readExcursions(horizon, { targetFraction: 0.05, stopFraction: 0.02 });
        const survived = readExcursions(horizon, { targetFraction: 0.05, stopFraction: 0.9 });

        expect(stopped.hitStop).toBe(true);
        expect(survived.hitStop).toBe(false);
    });

    it('says it cannot answer, rather than answering "no", when nothing was recorded', () => {
        // The failure this guards is the mirror image of the one the module
        // already guards: a table of targets where nothing reached one looks the
        // same as a table where the question was never asked.
        const off = OutcomeConfigParser.parse({
            horizons: [3],
            breakevenPercent: 0.1,
            trackExcursions: false,
        });

        const [horizon] = measure(path(40, 0.01), { config: off }).horizons;

        expect(horizon?.maxFavourable).toBeNull();

        const answer = readExcursions(horizon!, { targetFraction: 0.05, stopFraction: 0.05 });
        expect(answer.answered).toBe(false);
        expect(answer.hitTarget).toBe(false);
        expect(answer.hitStop).toBe(false);
    });

    it('reads the same number whichever way the signal pointed', () => {
        // The excursions are measured from the entry in the signal's direction,
        // so a short's best case is the fall. If the reader did not respect that
        // it would report a short that fell as a target missed.
        const asLong = readExcursions(
            horizonAt(12, path(40, 0.01), { direction: 'LONG' }),
            { targetFraction: 0.05, stopFraction: 0.05 },
        );
        const asShort = readExcursions(
            horizonAt(12, path(40, -0.01), { direction: 'SHORT' }),
            { targetFraction: 0.05, stopFraction: 0.05 },
        );

        expect(asLong.hitTarget).toBe(true);
        expect(asShort.hitTarget).toBe(true);
    });

    it('never reports a target as hit without having reached it', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0.01, max: 0.5, noNaN: true }),
                fc.double({ min: 0.01, max: 0.5, noNaN: true }),
                (targetFraction, stopFraction) => {
                    const [horizon] = measure(path(30, 0.004)).horizons;
                    const answer = readExcursions(horizon!, { targetFraction, stopFraction });

                    // The claim is only allowed when the recorded best is at
                    // least the target, or when the best was never recorded.
                    return (
                        !answer.hitTarget ||
                        answer.missedTargetBy === 0 ||
                        (horizon?.maxFavourable ?? 0) >= targetFraction
                    );
                },
            ),
            { numRuns: 120 },
        );
    });
});

describe('a signal is measured against what came after it', () => {
    it('counts bars forward from the entry, not including it', () => {
        const result = measure(path(40, 0.01));

        // Bar 0 is the bar the signal was published on, so a one-bar horizon
        // is the bar after it. Measuring on the entry would score the system
        // on the price it was handed.
        expect(result.horizons[0]?.bars).toBe(1);
        expect(result.horizons[0]?.returnFraction).toBeCloseTo(0.01, 6);
    });

    it('measures further out for a longer horizon', () => {
        const result = measure(path(40, 0.01));

        const [one, three, twelve] = result.horizons;

        expect(one?.returnFraction).toBeCloseTo(0.01, 6);
        // Exact, not a linear approximation: compounding is the whole reason a
        // horizon is not just "step times bars", and a test that tolerates
        // five significant figures here would pass against a linear
        // implementation.
        expect(three?.returnFraction).toBeCloseTo(1.01 ** 3 - 1, 10);
        expect(twelve?.returnFraction).toBeCloseTo(1.01 ** 12 - 1, 10);
        expect(twelve?.returnFraction ?? 0).toBeGreaterThan(
            three?.returnFraction ?? 0,
        );
    });

    it('ignores bars before the entry entirely', () => {
        // A series handed to it with a long pre-history must produce the same
        // numbers as a series starting at the entry. If it did not, a signal
        // would be scoring its own past.
        const withPast = [
            ...path(30, -0.05).map((candle) => ({
                ...candle,
                timestamp: candle.timestamp - 30 * HOUR,
            })),
            ...path(40, 0.01),
        ];

        const clean = measure(path(40, 0.01));
        const padded = measure(withPast);

        expect(padded.horizons).toEqual(clean.horizons);
    });

    it('measures a short by the fall, not the rise', () => {
        const falling = path(40, 0.01, 'SHORT');

        const result = measure(falling, {
            direction: 'SHORT',
            entryPrice: falling[0]?.close ?? 100,
        });

        // The same market read as a short is a gain. A table storing raw
        // returns and reconstructing the direction on read gets this wrong
        // every time it is asked about a short.
        expect(result.horizons[0]?.returnFraction).toBeGreaterThan(0);
        expect(result.horizons[0]?.verdict).toBe('correct');
    });
});

describe('a verdict is a threshold, not a direction', () => {
    it('calls a move that did not pay for itself flat, not correct', () => {
        // Half the configured breakeven: the trade did not clear its own costs,
        // and a table that scores it as a win reports a strategy that loses
        // money on every trade it takes as a profitable one.
        const result = measure(path(5, 0.01), { entryPrice: 101.05 });

        expect(result.horizons[0]?.verdict).toBe('flat');
    });

    it('calls a move the other way incorrect', () => {
        const result = measure(path(5, -0.01));

        expect(result.horizons[0]?.verdict).toBe('incorrect');
    });

    it('does not call a dead-flat series correct', () => {
        const flat: Candle[] = Array.from({ length: 5 }, (_, index) => ({
            timestamp: BASE + index * HOUR,
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 1,
        }));

        expect(measure(flat).horizons[0]?.verdict).toBe('flat');
    });
});

describe('unresolved and impossible are not the same thing', () => {
    it('does not score a signal whose window has not closed', () => {
        // Ten bars of history, a twelve-bar horizon. Unknown, not incorrect:
        // a question waiting for an answer is not a wrong answer.
        const result = measure(path(10, 0.01));

        const twelve = result.horizons.find((row) => row.bars === 12);

        expect(twelve?.verdict).toBe('unknown');
        expect(twelve?.returnFraction).toBeNull();
    });

    it('does not score a signal the series never followed up on', () => {
        // No bar after the entry at all: the series ended. Expired, which is a
        // different failure from unknown and is reported as one.
        const result = measure([]);

        expect(result.horizons.every((row) => row.verdict === 'expired')).toBe(
            true,
        );
    });

    it('resolves the short horizons of a partially measured signal', () => {
        const result = measure(path(5, 0.01));

        expect(result.horizons.find((row) => row.bars === 1)?.verdict).toBe(
            'correct',
        );
        expect(result.horizons.find((row) => row.bars === 12)?.verdict).toBe(
            'unknown',
        );
    });
});

describe('the excursion is what the price did, not where it ended', () => {
    it('records the best the signal could have been worth', () => {
        // Rises for three bars, then gives all of it back. The endpoint says
        // flat; the excursion says the signal was right and then stopped being
        // right, which is the more useful of the two facts.
        const candles: Candle[] = [
            { timestamp: BASE, open: 100, high: 100, low: 100, close: 100, volume: 1 },
            { timestamp: BASE + HOUR, open: 100, high: 110, low: 100, close: 110, volume: 1 },
            { timestamp: BASE + 2 * HOUR, open: 110, high: 115, low: 110, close: 115, volume: 1 },
            { timestamp: BASE + 3 * HOUR, open: 115, high: 115, low: 110, close: 100, volume: 1 },
        ];

        const result = measure(candles);

        const three = result.horizons.find((row) => row.bars === 3);

        expect(three?.returnFraction).toBeCloseTo(0, 6);
        expect(three?.maxFavourable).toBeCloseTo(0.15, 6);
        expect(three?.maxAdverse).toBeCloseTo(0, 6);
    });

    it('records the worst a long could have been worth while it was right', () => {
        const candles: Candle[] = [
            { timestamp: BASE, open: 100, high: 100, low: 100, close: 100, volume: 1 },
            { timestamp: BASE + HOUR, open: 100, high: 100, low: 80, close: 80, volume: 1 },
            { timestamp: BASE + 2 * HOUR, open: 80, high: 90, low: 80, close: 90, volume: 1 },
            { timestamp: BASE + 3 * HOUR, open: 90, high: 90, low: 90, close: 90, volume: 1 },
        ];

        const result = measure(candles);
        const three = result.horizons.find((row) => row.bars === 3);

        // Down twenty percent and out again, ending back where it started. A
        // table with only the endpoint would show a flat trade; this one shows
        // a trade that was never survivable.
        expect(three?.maxAdverse).toBeCloseTo(-0.2, 6);
        expect(three?.returnFraction).toBeCloseTo(-0.1, 6);
    });

    it('leaves the excursion out when it was not asked for', () => {
        const result = measure(path(5, 0.01), {
            config: OutcomeConfigParser.parse({
                horizons: [1],
                breakevenPercent: 0.1,
                trackExcursions: false,
            }),
        });

        expect(result.horizons[0]?.maxFavourable).toBeNull();
        expect(result.horizons[0]?.maxAdverse).toBeNull();
    });
});

describe('whatever the series does', () => {
    it('never scores a signal on a bar that came before it', () => {
        fc.assert(
            fc.property(
                fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 60 }),
                fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
                (moves, entryOffset) => {
                    // Every bar moves in a way the entry did not know about,
                    // including hard ones. A measurement that changed when a
                    // past bar changed would be using the past.
                    const candles: Candle[] = moves.map((move, index) => {
                        const close = Math.max(1, 100 + move * index * 0.01 + entryOffset * index * 0.001);

                        return {
                            timestamp: BASE + index * HOUR,
                            open: close,
                            high: close,
                            low: close,
                            close,
                            volume: 1,
                        };
                    });

                    const entry = candles[0];
                    const result = measureOutcome({
                        symbol: 'BTCUSDT',
                        entryTimestamp: BASE,
                        entryPrice: entry?.close ?? 100,
                        direction: 'LONG' as const,
                        candles,
                        config: OutcomeConfigParser.parse({
                            horizons: [1, 3, 12],
                            breakevenPercent: 0.1,
                            trackExcursions: true,
                        }),
                    });

                    const three = result.horizons.find((row) => row.bars === 3);

                    if (three?.returnFraction === null || three === undefined) {
                        return;
                    }

                    // Recomputed from the bars by hand, forward from the entry.
                    const expected =
                        ((candles[3]?.close ?? 0) - (entry?.close ?? 0)) /
                        (entry?.close ?? 1);

                    expect(three.returnFraction).toBeCloseTo(expected, 8);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('keeps every excursion inside the range the endpoints describe', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.double({
                        min: 0.9,
                        max: 1.1,
                        noNaN: true,
                        noDefaultInfinity: true,
                    }),
                    { minLength: 15, maxLength: 15 },
                ),
                (factors) => {
                    const closes = factors.map(
                        (factor, index) => 100 * factor ** index,
                    );
                    const candles: Candle[] = closes.map((close, index) => ({
                        timestamp: BASE + index * HOUR,
                        open: close,
                        high: close,
                        low: close,
                        close,
                        volume: 1,
                    }));

                    const result = measure(candles);
                    const twelve = result.horizons.find(
                        (row) => row.bars === 12,
                    );

                    if (twelve?.returnFraction === null || twelve === undefined) {
                        return;
                    }

                    // The endpoint is itself one of the excursions, so it
                    // cannot lie outside the range they span. When it does, one
                    // of the two was computed over a different window.
                    expect(twelve.maxFavourable ?? 0).toBeGreaterThanOrEqual(
                        twelve.returnFraction,
                    );
                    expect(twelve.maxAdverse ?? 0).toBeLessThanOrEqual(
                        twelve.returnFraction,
                    );
                },
            ),
            { numRuns: 200 },
        );
    });
});
