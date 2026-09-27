import { describe, expect, it } from 'vitest';

import { channelInflation, resampleWithCoverage, shuffledGapReturn } from './coverage-gap.js';

import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const base = Date.UTC(2021, 0, 1);

const hourly = (day: number, hours: number, high = 110, low = 90): Candle[] =>
    Array.from({ length: hours }, (_, hour) => ({
        timestamp: base + day * DAY + hour * HOUR,
        open: 100,
        high: high - hour,
        low: low + hour,
        close: 100,
        volume: 1,
    }));

const fullDay = (day: number): Candle[] => hourly(day, 24);

describe('a day missing its bars', () => {
    it('is reported, not silently absent', () => {
        // The point of the function over resampleToDaily alone. "Eight days"
        // was a number somebody had counted by hand; here it is output, and a
        // day cannot be in both lists or in neither.
        const coverage = resampleWithCoverage([...fullDay(0), ...fullDay(1), ...hourly(2, 20)]);

        expect(coverage.complete).toHaveLength(2);
        expect(coverage.dropped).toHaveLength(1);
        expect(coverage.dropped[0]?.timestamp).toBe(base + 2 * DAY);
        expect(coverage.dropped[0]?.hours).toBe(20);
        expect(coverage.withPartial).toHaveLength(3);
    });

    it('keeps the partial high and low, because they are the reason it is dropped', () => {
        // A reader looking at a dropped day needs to see the invented range,
        // not just a count. The count says how much is missing; the range says
        // how wrong the bar would have been.
        const coverage = resampleWithCoverage([...fullDay(0), ...hourly(1, 20, 200, 50)]);

        expect(coverage.dropped[0]?.partialHigh).toBeGreaterThan(110);
        expect(coverage.dropped[0]?.partialLow).toBeLessThan(90);
    });

    it('drops nothing when every day is whole', () => {
        const coverage = resampleWithCoverage([...fullDay(0), ...fullDay(1), ...fullDay(2)]);

        expect(coverage.dropped).toHaveLength(0);
        expect(coverage.complete).toHaveLength(3);
    });

    it('reports zero rather than inventing a day when there is no data', () => {
        const coverage = resampleWithCoverage([]);

        expect(coverage.complete).toHaveLength(0);
        expect(coverage.dropped).toHaveLength(0);
    });
});

describe('what a partial day does to a channel', () => {
    const wide = Array.from({ length: 30 }, (_, day) => ({
        timestamp: base + day * DAY,
        open: 100,
        high: 105,
        low: 95,
        close: 100,
        volume: 1,
    }));

    it('reports zero when the two series are the same', () => {
        const inflation = channelInflation(wide, wide, 20);

        expect(inflation.mean).toBe(0);
        expect(inflation.worst).toBe(0);
    });

    it('measures the widening a partial day causes, not the difference in levels', () => {
        // The clean channel is 10 wide (105 down to 95). A day that spiked to
        // 300 and then came back is 205 wide, so the channel is 19.5 times
        // wider than the market was — which is the whole reason these days are
        // dropped, and a much larger distortion than "eight days, no big deal".
        const withSpike = wide.map((candle, index) =>
            index === 10 ? { ...candle, high: 300 } : candle,
        );
        const inflation = channelInflation(wide, withSpike, 20);

        expect(inflation.worst).toBeCloseTo(19.5, 6);
        expect(inflation.mean).toBeGreaterThan(0);
    });

    it('says how many windows it looked at, so a zero can be trusted', () => {
        expect(channelInflation(wide, wide, 20).windows).toBe(10);
    });

    it('skips windows with no width rather than dividing by nothing', () => {
        const flat = Array.from({ length: 30 }, (_, day) => ({
            timestamp: base + day * DAY,
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 1,
        }));

        expect(Number.isFinite(channelInflation(flat, flat, 20).mean)).toBe(true);
    });
});

describe('the gap was a feed problem, not a market event', () => {
    it('produces a distribution rather than a number', () => {
        // The control's job is to say what a handful of arbitrary days in this
        // series would have returned. One number cannot do that; a spread can,
        // and a spread that came back identical every draw would mean the
        // shuffling did nothing.
        const days = Array.from({ length: 60 }, (_, i) => 100 * (1 + i * 0.01));
        const draws = shuffledGapReturn(days, 0x9e37_79b9, 500);

        expect(draws).toHaveLength(500);
        expect(new Set(draws).size).toBeGreaterThan(400);
        expect(draws.every((value) => Number.isFinite(value))).toBe(true);
    });

    it('is reproducible, so two runs can be compared', () => {
        const days = Array.from({ length: 30 }, (_, i) => 100 + i);

        expect(shuffledGapReturn(days, 7, 20)).toEqual(shuffledGapReturn(days, 7, 20));
    });

    it('gives a different answer for a different seed', () => {
        const days = Array.from({ length: 30 }, (_, i) => 100 + i);

        expect(shuffledGapReturn(days, 7, 20)).not.toEqual(shuffledGapReturn(days, 8, 20));
    });

    it('handles a series that cannot be divided, without producing a NaN', () => {
        const draws = shuffledGapReturn([0, 100, 0, 100], 3, 10);

        expect(draws.every((value) => Number.isFinite(value))).toBe(true);
    });
});
