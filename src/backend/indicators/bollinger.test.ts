import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import { calculateBollingerBands } from './bollinger.js';

const HOUR = 3_600_000;
const BASE = 1_699_999_200_000;

/**
 * Bars built from a series of closes, oldest first, newest last.
 *
 * The order matters and is the one the whole pipeline uses: a venue answers
 * with the oldest bar first, and every calculator here reads the last element
 * as the current one. A fixture built the other way round is not a stricter
 * test, it is a test of a market running backwards.
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

/** A series that rises by a fixed step, so a band is predictable. */
function ramp(count: number, step = 1): Candle[] {
    return candlesFrom(
        Array.from({ length: count }, (_, index) => 100 + index * step),
    );
}

describe('Bollinger Bands', () => {
    it('centres the middle band on the mean of the window', () => {
        const bands = calculateBollingerBands(ramp(20), 20, 2);

        // 100..119, mean 109.5.
        expect(bands.middle).toBeCloseTo(109.5, 10);
    });

    it('puts the bands the requested distance from the middle', () => {
        const wide = calculateBollingerBands(ramp(20), 20, 2);
        const tight = calculateBollingerBands(ramp(20), 20, 1);

        // A wider envelope is the same centre with a bigger deviation, so the
        // distance has to scale exactly.
        expect(wide.upper - wide.middle).toBeCloseTo(
            2 * (tight.upper - tight.middle),
            10,
        );
    });

    it('has no width in a market that has not moved', () => {
        const flat = calculateBollingerBands(candlesFrom(Array(20).fill(50)), 20, 2);

        expect(flat.upper).toBe(flat.middle);
        expect(flat.lower).toBe(flat.middle);
        expect(flat.bandwidth).toBe(0);
    });

    it('puts %B at the middle when there is no width to divide by', () => {
        // A flat series makes upper equal lower, and the ratio is a division
        // by zero. The honest answer is the middle: price has not moved.
        const flat = calculateBollingerBands(candlesFrom(Array(20).fill(50)), 20, 2);

        expect(flat.percentB).toBe(0.5);
    });

    it('places the last close between the bands', () => {
        const bands = calculateBollingerBands(ramp(20), 20, 2);

        // The newest bar is above its own window's mean, so it sits in the
        // upper half of the envelope.
        expect(bands.percentB).toBeGreaterThan(0.5);
        expect(bands.percentB).toBeLessThan(1);
    });

    it('lets %B leave 0..1, because price leaving the range is the reading', () => {
        const mostly = candlesFrom([...Array(19).fill(100), 500]);

        const bands = calculateBollingerBands(mostly, 20, 2);

        // Clamping would throw away the only moment this indicator says
        // anything: the close is outside every bar price in the window made.
        expect(bands.percentB).toBeGreaterThan(1);
    });

    it('reports bandwidth as a fraction, so two instruments are comparable', () => {
        const base = ramp(20);
        const scaled = candlesFrom(
            base.map((candle) => candle.close * 10),
        );

        // Scaling every price by ten scales the band width by ten and the
        // middle by ten, so the fraction between them is unchanged. That is
        // what makes a band on BTC comparable with a band on a cheap alt.
        expect(calculateBollingerBands(scaled, 20, 2).bandwidth).toBeCloseTo(
            calculateBollingerBands(base, 20, 2).bandwidth,
            12,
        );
    });

    it('refuses a window it was not given', () => {
        expect(() => calculateBollingerBands(ramp(5), 20, 2)).toThrow(
            /at least 20 candles/,
        );
    });

    it('refuses a period that cannot have a deviation', () => {
        expect(() => calculateBollingerBands(ramp(20), 1, 2)).toThrow(
            /greater than 1/,
        );
    });

    it('refuses a negative width', () => {
        expect(() => calculateBollingerBands(ramp(20), 20, -1)).toThrow(
            /must not be negative/,
        );
    });

    it('accepts a zero width without failing', () => {
        // Zero bands are a useless but well-defined answer. Rejecting it would
        // make a legitimate configuration a startup failure.
        const bands = calculateBollingerBands(ramp(20), 20, 0);

        expect(bands.upper).toBe(bands.middle);
        expect(bands.lower).toBe(bands.middle);
    });

    it('refuses an empty series', () => {
        expect(() => calculateBollingerBands([], 20, 2)).toThrow(
            /at least one candle/,
        );
    });

    it('uses the population deviation, not the sample one', () => {
        // Bollinger's original is a population standard deviation. The sample
        // one inflates the band by sqrt(n/(n-1)) — about five percent at period
        // 20 — which is visible and silent.
        const closes = Array.from({ length: 20 }, (_, index) => 100 + index);
        const bands = calculateBollingerBands(candlesFrom(closes), 20, 2);

        const middle = 109.5;
        const population = Math.sqrt(
            closes.reduce((total, close) => total + (close - middle) ** 2, 0) /
                20,
        );
        const sample = Math.sqrt(
            closes.reduce((total, close) => total + (close - middle) ** 2, 0) /
                19,
        );

        expect(bands.upper - bands.middle).toBeCloseTo(2 * population, 10);
        expect(bands.upper - bands.middle).not.toBeCloseTo(2 * sample, 6);
    });

    it('keeps the bands ordered whatever the data does', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 1, max: 100_000, noNaN: true }), {
                    minLength: 20,
                    maxLength: 40,
                }),
                (closes) => {
                    const bands = calculateBollingerBands(
                        candlesFrom(closes),
                        20,
                        2,
                    );

                    expect(bands.lower).toBeLessThanOrEqual(bands.middle);
                    expect(bands.middle).toBeLessThanOrEqual(bands.upper);
                    expect(bands.bandwidth).toBeGreaterThanOrEqual(0);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('measures the last window, not the whole series', () => {
        const long = calculateBollingerBands(ramp(100), 20, 2);
        const tail = calculateBollingerBands(ramp(100).slice(0, 20), 20, 2);

        // 100 bars into the ramp, the last twenty are bars 80..99; the bands
        // must describe those and not the hundred that came before.
        expect(long.middle).toBeCloseTo(189.5, 10);
        expect(tail.middle).toBeCloseTo(109.5, 10);
    });
});
