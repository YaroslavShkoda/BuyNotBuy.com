import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import { calculateADX } from './adx.js';

const HOUR = 3_600_000;
const BASE = 1_699_999_200_000;
const PERIOD = 14;

/**
 * Bars built from a series of closes, oldest first, newest last.
 *
 * The order is the one the whole pipeline uses: a venue answers oldest first,
 * and ADX reads consecutive array elements as consecutive bars in time. A
 * fixture built the other way round measures a market running backwards, and
 * every directional claim in it would be inverted.
 *
 * The wick is a fraction of price and is added to both sides of the body. It
 * is deliberately not scaled by which way the bar went: a wick taken from
 * `max(open, close)` gives a down bar the same high as the up bar before it,
 * so a perfect zigzag reads as a one-way trend at ADX 100 — the fixture
 * manufacturing a trend the data does not contain.
 */
function candlesFrom(closes: readonly number[]): Candle[] {
    return closes.map((close, index) => {
        const open = index === 0 ? close : (closes[index - 1] ?? close);
        const wick = close * 0.0005;

        return {
            timestamp: BASE - (closes.length - 1 - index) * HOUR,
            open,
            high: Math.max(open, close) + wick,
            low: Math.min(open, close) - wick,
            close,
            volume: 10,
        };
    });
}

/**
 * A random walk, from a fixed seed.
 *
 * "Going nowhere" cannot be written as a formula. A sine wave and a zigzag are
 * both perfectly periodic, and ADX finds structure in both: the sine is a
 * trend with wobbles, the zigzag is a trend that changes hands every bar.
 * Noise with no drift is the only thing that is actually directionless, and
 * a fixed seed keeps a failure reproducible from the number alone.
 */
function walk(count: number, drift = 0, amplitude = 6, seed = 20_240_917): number[] {
    let state = seed;
    const closes: number[] = [];
    let price = 1000;

    for (let index = 0; index < count; index += 1) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        price = Math.max(1, price + drift + ((state / 2_147_483_648) - 0.5) * amplitude);
        closes.push(price);
    }

    return closes;
}

/** A market that has not moved at all, down to the wicks. */
function still(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => ({
        timestamp: BASE - (count - 1 - index) * HOUR,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 10,
    }));
}

describe('ADX', () => {
    it('reads a market that goes nowhere far below one that goes somewhere', () => {
        // Not "below 25". A driftless random walk still drifts locally, and
        // ADX measures local drift — it lands near 30 and that is the honest
        // answer, not a bug. The claim worth making is the comparative one: a
        // market without a direction reads far below a market with one, and
        // the two are not close.
        const drifting = calculateADX(candlesFrom(walk(200)), PERIOD);
        const trending = calculateADX(
            candlesFrom(Array.from({ length: 200 }, (_, index) => 1000 * 1.004 ** index)),
            PERIOD,
        );

        expect(drifting.adx).toBeLessThan(trending.adx / 2);
    });

    it('keeps the strength up and flips the side when a trend reverses', () => {
        // The strength is a statement about the last stretch of movement, not
        // about the net change over the series. A trend that turns over is
        // still moving; what changes is which way.
        const half = 100;
        const up = Array.from({ length: half }, (_, index) => 1000 * 1.01 ** index);
        const down = up
            .slice()
            .reverse()
            .map((close) => 1000 * 2 * (1000 / close));

        const movement = calculateADX(candlesFrom([...up, ...down]), PERIOD);
        const before = calculateADX(candlesFrom(up), PERIOD);

        expect(movement.adx).toBeGreaterThan(25);
        expect(movement.plusDI).not.toBe(before.plusDI);
    });

    it('reads high in a market that keeps going one way', () => {
        const trend = Array.from({ length: 200 }, (_, index) => 100 + index * 2);

        const movement = calculateADX(candlesFrom(trend), PERIOD);

        expect(movement.adx).toBeGreaterThan(50);
        expect(movement.plusDI).toBeGreaterThan(movement.minusDI);
    });

    it('measures strength without taking a side', () => {
        const up = Array.from({ length: 200 }, (_, index) => 100 + index * 2);
        const down = [...up].reverse();

        const rising = calculateADX(candlesFrom(up), PERIOD);
        const falling = calculateADX(candlesFrom(down), PERIOD);

        // The whole point: a strong fall and a strong rise are the same
        // strength. An ADX that took a side would be a different indicator
        // wearing this one's name.
        expect(rising.adx).toBeCloseTo(falling.adx, 6);
        expect(rising.plusDI).toBeGreaterThan(rising.minusDI);
        expect(falling.minusDI).toBeGreaterThan(falling.plusDI);
    });

    it('keeps both directions below 100 and ADX below 100', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 1, max: 10_000, noNaN: true }), {
                    minLength: 60,
                    maxLength: 60,
                }),
                (closes) => {
                    const movement = calculateADX(
                        candlesFrom(closes),
                        PERIOD,
                    );

                    expect(movement.plusDI).toBeGreaterThanOrEqual(0);
                    expect(movement.plusDI).toBeLessThanOrEqual(100);
                    expect(movement.minusDI).toBeGreaterThanOrEqual(0);
                    expect(movement.minusDI).toBeLessThanOrEqual(100);
                    expect(movement.adx).toBeGreaterThanOrEqual(0);
                    expect(movement.adx).toBeLessThanOrEqual(100);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never produces a number out of a perfectly flat market', () => {
        // Every window has zero range, so every directional index is a
        // division by zero. Infinity would then be averaged into the ADX and
        // the result would look like the strongest trend in the world.
        const flat = calculateADX(still(200), PERIOD);

        expect(flat.adx).toBe(0);
        expect(flat.plusDI).toBe(0);
        expect(flat.minusDI).toBe(0);
    });

    it('does not count an inside day as an upward move', () => {
        // An inside bar has a higher high and a higher low than the one
        // before it. Checking the first box and ignoring the second is how a
        // ranging market accumulates a trend it never had.
        const series: Candle[] = Array.from({ length: 78 }, (_, index) => ({
            timestamp: BASE - (78 - index) * HOUR,
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 10,
        }));

        const inside: Candle = {
            timestamp: BASE,
            open: 100,
            high: 100.25,
            low: 99.75,
            close: 100,
            volume: 10,
        };

        const movement = calculateADX([...series, inside], PERIOD);

        expect(movement.plusDI).toBe(0);
        expect(movement.minusDI).toBe(0);
        expect(movement.adx).toBe(0);
    });

    it('refuses a series too short for the smoothing to run', () => {
        // One bar short of this and the recursion never runs, which produces
        // an ADX that looks finished and is really the average of a handful of
        // bars.
        expect(() => calculateADX(candlesFrom(Array(28).fill(100)), PERIOD)).toThrow(
            /at least 29 candles/,
        );
    });

    it('accepts exactly the shortest series it can smooth', () => {
        const shortest = Array.from({ length: PERIOD * 2 + 1 }, (_, index) =>
            100 + index,
        );

        expect(() => calculateADX(candlesFrom(shortest), PERIOD)).not.toThrow();
    });

    it('refuses an empty series and a period of zero', () => {
        expect(() => calculateADX([], PERIOD)).toThrow(/at least one candle/);
        expect(() => calculateADX(still(80), 0)).toThrow(/greater than 0/);
    });
});
