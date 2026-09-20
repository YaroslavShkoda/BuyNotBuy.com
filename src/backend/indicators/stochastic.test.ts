import { describe, expect, it } from 'vitest';
import { calculateStochastic } from './stochastic';
import type { Candle } from '../types/market';
import { createReactServerErrorHandler } from 'next/dist/server/app-render/create-error-handler';

function createCandle(
    high: number,
    low: number,
    close: number,
): Candle {
    return {
        timestamp: Date.now(),
        open: close,
        high,
        low,
        close,
        volume: 100,
    };
}

describe('calculateStochastic', () => {
    it('calculates stochastic correctly', () => {
        const candles = [
            createCandle(110, 90, 100),
            createCandle(115, 95, 105),
            createCandle(120, 100, 110),
        ];

        const result = calculateStochastic(candles, 3);

        expect(result).toBeCloseTo(66.666666666);
    });

    it('throws an error for empty candles', () => {
        expect(() => calculateStochastic([], 3))
            .toThrow('Stochastic requires at least one candle');
    });

    it('throws an error for invalid period', () => {
        const candles = [
            createCandle(110, 90, 100),
        ];

        expect(() => calculateStochastic(candles, 0))
            .toThrow('Stochastic period must be greater than 0');
    });

    it ('throws an error when there are not enough candles', () => {
        const candles = [
            createCandle(110, 90, 100),
            createCandle(115, 95, 105),
        ];

        expect(() => calculateStochastic(candles, 3))
            .toThrow('Stochastic requires at least 3 candles');
    });

    it('throws an error when the price range is zero', () => {
        const candles = [
            createCandle(100, 100, 100),
            createCandle(100, 100, 100),
            createCandle(100, 100, 100),
        ];

        expect(() => calculateStochastic(candles, 3))
            .toThrow('Stochastic cannot be calculated when highest high equals lowest low')
    })
})

