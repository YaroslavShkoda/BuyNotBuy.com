import { describe, expect, it } from 'vitest';

import { calculateMomentum } from './momentum.js';
import type { Candle } from '../types/market.js';

function createCandle(close: number): Candle {
    return {
        timestamp: Date.now(),
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
    };
}

describe('calculateMomentum', () => {
    it('calculates positive momentum as a percentage of the base price', () => {
        const candles = [
            createCandle(100),
            createCandle(110),
            createCandle(120),
            createCandle(130),
        ];

        const result = calculateMomentum(
            candles,
            2,
        );

        // (130 - 110) / 110 = +18.18%, not +20 dollars.
        expect(result).toBeCloseTo(20 / 1.1, 10);
    });

    it('calculates negative momentum as a percentage of the base price', () => {
        const candles = [
            createCandle(130),
            createCandle(120),
            createCandle(110),
            createCandle(100),
        ];

        const result = calculateMomentum(
            candles,
            2,
        );

        // (100 - 120) / 120 = -16.67%, not -20 dollars.
        expect(result).toBeCloseTo(-20 / 1.2, 10);
    });

    it('is invariant to the price scale', () => {
        // The old absolute delta read 5x larger at $100k than at $20k for the
        // very same move, which made momentum incomparable between regimes.
        const small = calculateMomentum(
            [
                createCandle(20000),
                createCandle(21000),
                createCandle(22000),
            ],
            2,
        );

        const large = calculateMomentum(
            [
                createCandle(100000),
                createCandle(105000),
                createCandle(110000),
            ],
            2,
        );

        expect(small).toBeCloseTo(large, 10);
    });

    it('returns zero when prices are equal', () => {
        const candles = [
            createCandle(100),
            createCandle(110),
            createCandle(100),
        ];

        const result = calculateMomentum(
            candles,
            2,
        );

        expect(result).toBe(0);
    });

    it('throws when the base price is zero', () => {
        expect(() => calculateMomentum(
            [
                createCandle(0),
                createCandle(50),
                createCandle(100),
            ],
            2,
        )).toThrow(
            'Momentum cannot be calculated against a zero base price',
        );
    });

    it('throws when candles are empty', () => {
        expect(() =>
            calculateMomentum([], 100),
        ).toThrow(
            'Momentum requires at least one candle',
        );
    });

    it('throws when period is zero or negative', () => {
        const candles = [
            createCandle(100),
        ];

        expect(() =>
            calculateMomentum(candles, 0),
        ).toThrow(
            'Momentum period must be greater than 0',
        );
    });

    it('throws when there are not enough candles', () => {
        const candles = Array.from(
            { length: 100 },
            (_, index) =>
                createCandle(100 + index),
        );

        expect(() =>
            calculateMomentum(candles, 100),
        ).toThrow(
            'Momentum requires at least 101 candles',
        );
    });
});
