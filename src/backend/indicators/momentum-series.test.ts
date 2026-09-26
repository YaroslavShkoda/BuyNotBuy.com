import { describe, expect, it } from 'vitest';

import type { Candle } from '../types/market.js';
import { calculateMomentumSeries } from './momentum-series.js';

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

describe('calculateMomentumSeries', () => {
    it('calculates momentum for every candle after the period', () => {
        const candles = [
            createCandle(100),
            createCandle(105),
            createCandle(110),
            createCandle(115),
            createCandle(120),
        ];

        const result = calculateMomentumSeries(candles, 2);

        expect(result).toHaveLength(5);
        expect(result[0]).toBeNull();
        expect(result[1]).toBeNull();
        expect(result[2]).toBeCloseTo(10, 10);
        expect(result[3]).toBeCloseTo((115 - 105) / 105 * 100, 10);
        expect(result[4]).toBeCloseTo((120 - 110) / 110 * 100, 10);
    });

    it('calculates negative momentum correctly', () => {
        const candles = [
            createCandle(120),
            createCandle(115),
            createCandle(110),
            createCandle(105),
        ];

        const result = calculateMomentumSeries(candles, 2);

        expect(result[2]).toBeCloseTo((110 - 120) / 120 * 100, 10);
        expect(result[3]).toBeCloseTo((105 - 115) / 115 * 100, 10);
    });

    it('returns zero when prices are equal', () => {
        const candles = [
            createCandle(100),
            createCandle(100),
            createCandle(100),
        ];

        const result = calculateMomentumSeries(candles, 2);

        expect(result).toEqual([
            null,
            null,
            0,
        ]);
    });

    it('throws when candles are empty', () => {
        expect(() => calculateMomentumSeries([], 100)).toThrow(
            'Momentum series requires at least one candle',
        );
    });

    it('throws when period is zero or negative', () => {
        const candles = [createCandle(100)];

        expect(() => calculateMomentumSeries(candles, 0)).toThrow(
            'Momentum period must be greater than 0',
        );
    });

    it('returns null when there is not enough history', () => {
        const candles = [
            createCandle(100),
            createCandle(110),
            createCandle(120),
        ];

        const result = calculateMomentumSeries(candles, 100);

        expect(result).toEqual([
            null,
            null,
            null,
        ]);
    });
});
