import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { calculateADX } from './adx.js';

import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
const BASE = 1_699_999_200_000;

function candlesFrom(closes: readonly number[]): Candle[] {
    return closes.map((close, index) => ({
        timestamp: BASE - index * HOUR,
        open: close - 0.5,
        high: close + 1,
        low: close - 1.5,
        close,
        volume: 10,
    }));
}

const PERIOD = 14;

describe('ADX', () => {
    it('reads near zero in a market that is going nowhere', () => {
        // Alternating up and down bars have no directional movement at all,
        // which is the case ADX exists to name.
        const sideways = Array.from({ length: 80 }, (_, index) =>
            100 + (index % 2),
        );

        expect(calculateADX(candlesFrom(sideways), PERIOD).adx).toBeLessThan(
            25,
        );
    });

    it('reads high in a market that keeps going one way', () => {
        const trend = Array.from({ length: 80 }, (_, index) => 100 + index * 2);

        const movement = calculateADX(candlesFrom(trend), PERIOD);

        expect(movement.adx).toBeGreaterThan(50);
        expect(movement.plusDI).toBeGreaterThan(movement.minusDI);
    });

    it('measures strength without taking a side', () => {
        const up = Array.from({ length: 80 }, (_, index) => 100 + index * 2);
        const down = Array.from({ length: 80 }, (_, index) => 260 - index * 2);

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
        const flat = calculateADX(
            candlesFrom(Array(80).fill(100)),
            PERIOD,
        );

        expect(flat.adx).toBe(0);
        expect(flat.plusDI).toBe(0);
        expect(flat.minusDI).toBe(0);
    });

    it('does not count an inside day as an upward move', () => {
        // An inside bar has a higher high and a higher low. Checking the first
        // box and ignoring the second is how a ranging market accumulates a
        // trend it never had.
        const inside: Candle[] = [
            {
                timestamp: BASE,
                open: 99,
                high: 105,
                low: 95,
                close: 100,
                volume: 10,
            },
            {
                timestamp: BASE - HOUR,
                open: 100,
                high: 104,
                low: 96,
                close: 101,
                volume: 10,
            },
            ...Array.from({ length: 78 }, (_, index) => ({
                timestamp: BASE - (index + 2) * HOUR,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 10,
            })),
        ];

        const movement = calculateADX(inside, PERIOD);

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
        expect(() => calculateADX(candlesFrom(Array(80).fill(100)), 0)).toThrow(
            /greater than 0/,
        );
    });
});
