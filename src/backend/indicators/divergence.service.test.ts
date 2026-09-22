import { describe, expect, it } from 'vitest';

import type { Candle } from '../types/market';

import {
    analyzeDivergence,
} from './divergence.service';

function createCandle(
    close: number,
    index: number,
): Candle {
    return {
        timestamp: index,
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
    };
}

describe('analyzeDivergence', () => {
    it('detects bullish divergence', () => {
        const closes = [
            100, 92, 79, 86, 69, 55, 60,
            66, 56, 60, 47, 29, 14, -1,
            -10, 0, 17, 3, 19, 39,
        ];

        const candles = closes.map(
            (close, index) =>
                createCandle(close, index),
        );

        const result = analyzeDivergence(
            candles,
            3,
            1,
            1,
            20,
        );

        expect(result.bullish?.type).toBe('BULLISH');
        expect(result.bearish).toBeNull();
    });

    it('returns no divergence when there is not enough price history', () => {
        const candles = Array.from(
            { length: 10 },
            (_, index) =>
                createCandle(100 + index, index),
        );

        const result = analyzeDivergence(
            candles,
            3,
        );

        expect(result).toEqual({
            bullish: null,
            bearish: null,
        });
    });

    it('returns no divergence when candles are empty', () => {
        expect(() =>
            analyzeDivergence([], 3),
        ).toThrow(
            'Divergence analysis requires at least one candle',
        );
    });

    it('throws when max distance is negative', () => {
        const candles = Array.from(
            { length: 20 },
            (_, index) =>
                createCandle(100, index),
        );

        expect(() =>
            analyzeDivergence(
                candles,
                3,
                2,
                2,
                -1,
            ),
        ).toThrow(
            'Divergence max distance must be greater than or equal to 0',
        );
    });
});
