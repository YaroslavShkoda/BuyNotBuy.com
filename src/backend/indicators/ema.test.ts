import { describe, expect, it } from 'vitest';
import { calculateEMA } from './ema';

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
});