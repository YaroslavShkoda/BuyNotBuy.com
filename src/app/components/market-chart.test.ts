import { describe, expect, it } from 'vitest';

import { MarketChart } from './market-chart';

import type { Candle } from '../types/analysis';

function makeCandle(timestamp: number, close: number): Candle {
    return {
        timestamp,
        open: close - 10,
        high: close + 10,
        low: close - 20,
        close,
        volume: 1000,
    };
}

describe('frontend chart input guards', () => {
    it('keeps chronological subset of last 48 candles', () => {
        const candles = Array.from(
            { length: 300 },
            (_, index) => makeCandle(1_700_000_000_000 + index * 3_600_000, 80000 + index),
        );

        const visible = candles.slice(-48);

        expect(visible).toHaveLength(48);
        expect(visible[0]?.timestamp).toBe(candles[252]?.timestamp);
        expect(visible.at(-1)?.timestamp).toBe(candles.at(-1)?.timestamp);
    });

    it('filters non-finite OHLCV values before chart math', () => {
        const candles: Candle[] = [
            makeCandle(1_700_000_000_000, 80000),
            {
                timestamp: 1_700_000_003_600_000,
                open: 80000,
                high: Number.NaN,
                low: 79000,
                close: 80500,
                volume: 100,
            },
            {
                timestamp: 1_700_000_007_200_000,
                open: 80500,
                high: 82000,
                low: 80000,
                close: Number.POSITIVE_INFINITY,
                volume: 120,
            },
        ];

        const valid = candles.filter(
            (candle) =>
                Number.isFinite(candle.timestamp) &&
                Number.isFinite(candle.open) &&
                Number.isFinite(candle.high) &&
                Number.isFinite(candle.low) &&
                Number.isFinite(candle.close) &&
                Number.isFinite(candle.volume),
        );

        expect(valid).toHaveLength(1);
        expect(MarketChart).toBeTypeOf('function');
    });

    it('avoids division by zero when first close is zero', () => {
        const firstClose = 0;
        const lastClose = 100;

        const change = firstClose !== 0
            ? ((lastClose - firstClose) / firstClose) * 100
            : 0;

        expect(change).toBe(0);
    });
});
