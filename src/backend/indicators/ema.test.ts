import { describe, expect, it } from 'vitest';
import { calculateEMA } from './ema.js';

function simpleMovingAverage(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe('calculateEMA', () => {
    it('calculates EMA correctly', () => {
        const values = [10, 20, 30, 40, 50];

        const result = calculateEMA(values, 3);

        expect(result).toBeCloseTo(40);
    });

    it('throws when values are empty', () => {
        expect(() => calculateEMA([], 3)).toThrow(
            'EMA requires at least one value',
        );
    });

    it('throws when period is zero or negative', () => {
        expect(() => calculateEMA([10, 20, 30], 0)).toThrow(
            'EMA period must be greater than 0',
        );
    });

    it('throws when there are not enough values', () => {
        expect(() => calculateEMA([10, 20], 3)).toThrow(
            'EMA requires at least 3 values',
        );
    });

    it('recurses over every value beyond the seed', () => {
        // A 300-bar window with period 300 runs the loop zero times and returns
        // the seed SMA verbatim. One extra bar must already move the result.
        const window = Array.from({ length: 300 }, (_, index) => 100 + index);
        const extended = [...window, 400];

        expect(calculateEMA(window, 300)).toBeCloseTo(249.5, 6);
        expect(calculateEMA(extended, 300)).not.toBeCloseTo(249.5, 6);
    });

    it('differs from the SMA of the same window once the warm-up has room', () => {
        // Regression for the production bug: with period 300 and a 900-bar
        // window the EMA must be its own value, not the 900-bar SMA.
        const values = Array.from({ length: 900 }, (_, index) => 100 + index);

        const ema = calculateEMA(values, 300);
        const sma = simpleMovingAverage(values);

        expect(ema).not.toBeCloseTo(sma, 6);
        expect(ema).toBeCloseTo(849.5, 6);
    });

    it('lags a linear ramp by exactly (period - 1) / 2', () => {
        // A linear ramp has an exact EMA solution, so the expected value can
        // be derived independently of the implementation.
        const values = Array.from({ length: 900 }, (_, index) => index);
        const last = values.at(-1) ?? 0;

        expect(calculateEMA(values, 300)).toBeCloseTo(last - 299 / 2, 6);
    });

    it('tracks a persistent step instead of staying at the seed', () => {
        const flat = Array.from({ length: 900 }, () => 100);
        const stepped = [...flat.slice(0, 600), ...Array.from({ length: 300 }, () => 200)];

        const ema = calculateEMA(stepped, 300);

        expect(ema).toBeGreaterThan(100);
        expect(ema).toBeLessThan(200);
        expect(ema).toBeGreaterThan(150);
    });
});
