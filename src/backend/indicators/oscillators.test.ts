import { describe, expect, it } from 'vitest';

import { calculateATR } from './atr.js';
import { calculateRSI } from './rsi.js';
import { calculateMACD } from './macd.js';

import type { Candle } from '../types/market.js';

function candle(timestamp: number, high: number, low: number, close: number): Candle {
    return { timestamp, open: close, high, low, close, volume: 1 };
}

function rising(count: number, step = 1, from = 100): Candle[] {
    return Array.from({ length: count }, (_unused, index) =>
        candle(index, from + step * index + 1, from + step * index - 1, from + step * index),
    );
}

function falling(count: number, step = 1, from = 200): Candle[] {
    return Array.from({ length: count }, (_unused, index) =>
        candle(index, from - step * index + 1, from - step * index - 1, from - step * index),
    );
}

describe('ATR', () => {
    it('is zero when nothing moves', () => {
        const flat = Array.from({ length: 20 }, (_unused, index) => candle(index, 100, 100, 100));

        expect(calculateATR(flat, 14)).toBe(0);
    });

    it('measures the full range of a bar that only gaps', () => {
        // A bar that opens far from the previous close has a true range larger
        // than its own high-low. Taking high-low alone would miss the gap, and
        // a gap is exactly when a stop is triggered.
        const candles = [
            candle(0, 100, 100, 100),
            candle(1, 130, 120, 125),
        ];

        // high - previous close = 30 beats high - low = 10.
        expect(calculateATR(candles, 1)).toBeCloseTo(30 / 125, 10);
    });

    it('is a fraction of price, so it compares between instruments', () => {
        const candles = rising(30, 5);

        const doubled = candles.map((c) => ({
            ...c,
            high: c.high * 2,
            low: c.low * 2,
            close: c.close * 2,
            open: c.open * 2,
        }));

        // The same shape at twice the price has to give the same percentage.
        expect(calculateATR(doubled, 14)).toBeCloseTo(calculateATR(candles, 14), 12);
    });

    it('only uses the most recent window', () => {
        const calm = Array.from({ length: 30 }, (_unused, index) => candle(index, 100, 100, 100));
        const wild = [...calm.slice(0, 20), candle(20, 200, 10, 150), candle(21, 200, 10, 150)];

        // The 14 most recent bars carry the move; the calm before them is
        // outside the window and must not dilute it.
        const fromWild = calculateATR(wild, 14);
        const wildOnly = calculateATR(wild.slice(-15), 14);

        expect(fromWild).toBeCloseTo(wildOnly, 12);
    });

    it('needs one more candle than its period', () => {
        // The first candle has no previous close, so it contributes no range.
        expect(() => calculateATR(rising(14), 14)).toThrow();
        expect(() => calculateATR(rising(15), 14)).not.toThrow();
    });

    it('refuses a zero price rather than reporting no volatility', () => {
        const zeroed = rising(20).map((c) => ({ ...c, close: 0 }));

        // Zero would read as "the market is perfectly calm".
        expect(() => calculateATR(zeroed, 14)).toThrow();
    });
});

describe('RSI', () => {
    it('is 100 when there is not a single down bar', () => {
        // A ratio against a zero average loss is a division by nothing. The
        // honest answer is the top of the scale, not Infinity.
        expect(calculateRSI(rising(40), 14)).toBe(100);
    });

    it('is 0 when there is not a single up bar', () => {
        expect(calculateRSI(falling(40), 14)).toBe(0);
    });

    it('is 50 when nothing moves at all', () => {
        const flat = Array.from({ length: 40 }, (_unused, index) => candle(index, 100, 100, 100));

        expect(calculateRSI(flat, 14)).toBe(50);
    });

    it('stays inside 0-100 for any series', () => {
        const zigzag = Array.from({ length: 80 }, (_unused, index) => {
            const close = 100 + (index % 2 === 0 ? 3 : -3) * (index % 7);

            return candle(index, close + 1, close - 1, close);
        });

        const value = calculateRSI(zigzag, 14);

        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
    });

    it('reads higher after a run of gains than after a run of losses', () => {
        const up = calculateRSI(rising(40), 14);
        const down = calculateRSI(falling(40), 14);

        expect(up).toBeGreaterThan(down);
    });

    it('needs one more candle than its period', () => {
        expect(() => calculateRSI(rising(14), 14)).toThrow();
        expect(() => calculateRSI(rising(15), 14)).not.toThrow();
    });
});

describe('MACD', () => {
    it('never reports a value without enough history', () => {
        // The signal line is an average of the MACD line, so the MACD line has
        // to exist for a full signal window before there is anything to smooth.
        expect(() => calculateMACD([1, 2, 3], 12, 26, 9)).toThrow();
        expect(() => calculateMACD(new Array(40).fill(100), 12, 26, 9)).not.toThrow();
    });

    it('refuses a fast period that is not faster', () => {
        // A "fast" average slower than the "slow" one inverts the histogram
        // rather than merely producing a different number.
        expect(() => calculateMACD(new Array(60).fill(100), 26, 12, 9)).toThrow();
    });

    it('puts the histogram above zero when the fast line leads', () => {
        const accelerating = Array.from({ length: 80 }, (_unused, index) => 100 + index * index * 0.1);

        const result = calculateMACD(accelerating, 12, 26, 9);

        // Price is rising faster than a slow average can follow, so the fast
        // line is above the slow one and the histogram is positive.
        expect(result.histogram).toBeGreaterThan(0);
        expect(result.macd).toBeGreaterThan(0);
    });

    it('puts the histogram below zero when the fast line lags', () => {
        const decelerating = Array.from({ length: 80 }, (_unused, index) => 500 - index * index * 0.1);

        const result = calculateMACD(decelerating, 12, 26, 9);

        expect(result.histogram).toBeLessThan(0);
        expect(result.macd).toBeLessThan(0);
    });

    it('reports a histogram equal to the distance between the two lines', () => {
        const closes = Array.from({ length: 80 }, (_unused, index) => 100 + Math.sin(index / 3) * 20);

        const result = calculateMACD(closes, 12, 26, 9);

        // The histogram is derived, not independently computed. If it drifts
        // from its own definition the two lines and the bar stop agreeing.
        expect(result.histogram).toBeCloseTo(result.macd - result.signal, 12);
    });

    it('is exactly zero on a flat market', () => {
        const flat = new Array(80).fill(100);

        const result = calculateMACD(flat, 12, 26, 9);

        expect(result.macd).toBeCloseTo(0, 10);
        expect(result.signal).toBeCloseTo(0, 10);
        expect(result.histogram).toBeCloseTo(0, 10);
    });
});
