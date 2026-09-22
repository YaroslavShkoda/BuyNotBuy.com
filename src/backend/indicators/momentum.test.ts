import { describe, expect, it } from 'vitest';

import { calculateMomentum } from './momentum';
import type { Candle } from '../types/market';

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
    it('calculates positive momentum correctly', () => {
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

        expect(result).toBe(20);
    });

    it('calculates negative momentum correctly', () => {
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

        expect(result).toBe(-20);
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
