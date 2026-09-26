import { describe, expect, it } from 'vitest';

import { summariseVolume } from './volume-summary';

import type { Candle } from '../types/analysis';

const HOUR = 3_600_000;

function candle(offsetHours: number, volume: number): Candle {
    return {
        timestamp: HOUR + offsetHours * HOUR,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume,
    };
}

describe('volume summary', () => {
    it('reports nothing for a window with no candles', () => {
        expect(summariseVolume([])).toEqual({
            count: 0,
            total: 0,
            average: 0,
            median: 0,
            max: null,
            min: null,
            peakRatio: 0,
        });
    });

    it('finds the biggest and smallest hour, and says when they were', () => {
        const summary = summariseVolume([
            candle(0, 100),
            candle(1, 400),
            candle(2, 250),
            candle(3, 40),
        ]);

        expect(summary.max).toEqual({ value: 400, timestamp: HOUR + HOUR });
        expect(summary.min).toEqual({ value: 40, timestamp: HOUR + 3 * HOUR });
    });

    it('keeps the earliest hour when two tie', () => {
        // Two hours at the same volume are the same figure. Reporting the later
        // one would move the label for no reason the reader can see.
        const summary = summariseVolume([candle(0, 200), candle(1, 200)]);

        expect(summary.max?.timestamp).toBe(HOUR);
    });

    it('totals and averages the window', () => {
        const summary = summariseVolume([candle(0, 100), candle(1, 300)]);

        expect(summary.count).toBe(2);
        expect(summary.total).toBe(400);
        expect(summary.average).toBe(200);
    });

    it('takes the median of the middle pair for an even count', () => {
        const summary = summariseVolume([candle(0, 10), candle(1, 20), candle(2, 30), candle(3, 40)]);

        expect(summary.median).toBe(25);
    });

    it('reports the median and the average separately', () => {
        // The whole point of the pair: four quiet hours and one loud one, where
        // the average says busy and the median says the window was quiet.
        const summary = summariseVolume([
            candle(0, 10),
            candle(1, 11),
            candle(2, 12),
            candle(3, 13),
            candle(4, 1000),
        ]);

        expect(summary.average).toBeCloseTo(209.2, 10);
        expect(summary.median).toBe(12);
        expect(summary.average).toBeGreaterThan(summary.median * 10);
    });

    it('expresses the peak as a multiple of the average', () => {
        // Scale-free, so it reads the same on a quiet market and a frantic one:
        // a mean of 100 with a 200 peak is twice the norm, whatever the units.
        const summary = summariseVolume([candle(0, 50), candle(1, 50), candle(2, 200)]);

        expect(summary.average).toBe(100);
        expect(summary.peakRatio).toBeCloseTo(2, 10);
    });

    it('reports no peak ratio for a window that never traded', () => {
        const summary = summariseVolume([candle(0, 0), candle(1, 0)]);

        expect(summary.average).toBe(0);
        expect(summary.peakRatio).toBe(0);
        expect(summary.max).toEqual({ value: 0, timestamp: HOUR });
    });

    it('drops an unusable volume instead of counting it as zero', () => {
        // Zero would drag the average down and invent a minimum that never
        // happened, which is worse than leaving the hour out.
        const summary = summariseVolume([
            candle(0, 100),
            candle(1, Number.NaN),
            candle(2, 300),
        ]);

        expect(summary.count).toBe(2);
        expect(summary.average).toBe(200);
        expect(summary.min?.value).toBe(100);
    });

    it('survives a window of nothing but unusable volumes', () => {
        expect(summariseVolume([candle(0, Number.POSITIVE_INFINITY)]).count).toBe(0);
    });
});
