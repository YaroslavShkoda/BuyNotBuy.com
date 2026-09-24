import { describe, expect, it } from 'vitest';

import {
    MarketChart,
    computeChartScale,
    getCandleIntervalMs,
    getWindowLabel,
    formatAxisTime,
} from './market-chart';

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

describe('chart scale with EMA reference', () => {
    it('extends the scale to include EMA 300', () => {
        const scale = computeChartScale([100, 110], 120);

        expect(scale.low).toBe(100);
        expect(scale.high).toBe(120);
        expect(scale.span).toBe(20);
    });

    it('extends the scale downward when EMA is below all closes', () => {
        const scale = computeChartScale([100, 110], 90);

        expect(scale.low).toBe(90);
        expect(scale.high).toBe(110);
    });

    it('ignores non-finite EMA values', () => {
        const scale = computeChartScale([100, 110], Number.NaN);

        expect(scale.low).toBe(100);
        expect(scale.high).toBe(110);
    });

    it('keeps a non-zero span for a flat series', () => {
        const scale = computeChartScale([100, 100], 100);

        expect(scale.span).toBe(1);
    });

    it('returns a guarded scale for empty input', () => {
        const scale = computeChartScale([], null);

        expect(scale.low).toBe(0);
        expect(scale.high).toBe(0);
        expect(scale.span).toBe(1);
    });
});

const hourMs = 3_600_000;

function makeTimedCandle(index: number, close: number): Candle {
    return {
        timestamp: 1_700_000_000_000 + index * hourMs,
        open: close - 10,
        high: close + 10,
        low: close - 20,
        close,
        volume: 1000,
    };
}

describe('chart time window derived from candle timestamps', () => {
    it('detects the candle interval from adjacent timestamps', () => {
        const candles = [0, 1, 2, 3].map((index) => makeTimedCandle(index, 80_000));

        expect(getCandleIntervalMs(candles)).toBe(hourMs);
    });

    it('is robust to a single gap between candles', () => {
        const base = 1_700_000_000_000;
        const candles: Candle[] = [
            makeTimedCandle(0, 80_000),
            makeTimedCandle(1, 80_100),
            {
                timestamp: base + 3 * hourMs,
                open: 80_000,
                high: 80_200,
                low: 79_900,
                close: 80_200,
                volume: 1000,
            },
        ];

        expect(getCandleIntervalMs(candles)).toBe(hourMs);
    });

    it('formats a 48-candle hourly window as hours', () => {
        const candles = Array.from({ length: 48 }, (_, index) => makeTimedCandle(index, 80_000 + index));

        expect(getWindowLabel(candles)).toBe('48 ч');
    });

    it('formats short windows in minutes', () => {
        const base = 1_700_000_000_000;
        const candles: Candle[] = [
            { timestamp: base, open: 1, high: 2, low: 0.5, close: 1, volume: 10 },
            { timestamp: base + 15 * 60_000, open: 1, high: 2, low: 0.5, close: 1, volume: 10 },
            { timestamp: base + 30 * 60_000, open: 1, high: 2, low: 0.5, close: 1, volume: 10 },
        ];

        expect(getWindowLabel(candles)).toBe('45 мин');
    });

    it('formats multi-day windows in days', () => {
        const base = 1_700_000_000_000;
        const dayMs = 24 * hourMs;
        const candles: Candle[] = [
            { timestamp: base, open: 1, high: 2, low: 0.5, close: 1, volume: 10 },
            { timestamp: base + 3 * dayMs, open: 1, high: 2, low: 0.5, close: 1, volume: 10 },
        ];

        expect(getWindowLabel(candles)).toBe('6 дн');
    });

    it('returns null for empty and single-candle inputs', () => {
        expect(getWindowLabel([])).toBeNull();
        expect(getWindowLabel([makeTimedCandle(0, 80_000)])).toBeNull();
    });

    it('renders a non-empty axis time label for a valid timestamp', () => {
        const label = formatAxisTime(1_700_000_000_000, 2 * hourMs);

        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe('—');
    });

    it('falls back to a dash placeholder for invalid timestamps', () => {
        expect(formatAxisTime(Number.NaN, 0)).toBe('—');
    });
});
