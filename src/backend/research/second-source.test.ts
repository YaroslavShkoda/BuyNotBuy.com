import { describe, expect, it } from 'vitest';

import { compareSources, dayOf, overlap, pValueOnBoth } from './second-source.js';

import type { Candle } from '../types/market.js';

const day = 86_400_000;
const base = Date.UTC(2021, 0, 1);

const candle = (timestamp: number, close: number, high = close * 1.01): Candle => ({
    timestamp,
    open: close,
    high,
    low: close * 0.99,
    close,
    volume: 1,
});

describe('two sources that do not agree on midnight', () => {
    it('matches them on the day, not on the instant', () => {
        // Yahoo's session boundary is 12:00 UTC and Binance's is 00:00, so the
        // two label the same trading day twelve hours apart. Matching on the
        // timestamp finds nothing — and "nothing" is a silent zero that prints
        // a beautiful table of 0.00% gaps. It did.
        const binance = [candle(base, 100), candle(base + day, 101)];
        const yahoo = [
            candle(base + 12 * 3_600_000, 100.5),
            candle(base + day + 12 * 3_600_000, 101.5),
        ];
        const pair = overlap(binance, yahoo);

        expect(pair.a).toHaveLength(2);
        expect(pair.b).toHaveLength(2);
    });

    it('still drops days the other source simply does not have', () => {
        const binance = [candle(base, 100), candle(base + day, 101), candle(base + 2 * day, 102)];
        const yahoo = [candle(base, 100.5), candle(base + 2 * day, 102.5)];
        const pair = overlap(binance, yahoo);

        expect(pair.a).toHaveLength(2);
        expect(pair.a.map((c) => dayOf(c.timestamp))).toEqual([
            '2021-01-01',
            '2021-01-03',
        ]);
    });

    it('names the day in UTC, so two clocks still agree on it', () => {
        expect(dayOf(base)).toBe('2021-01-01');
        expect(dayOf(base + 23 * 3_600_000)).toBe('2021-01-01');
        expect(dayOf(base + day)).toBe('2021-01-02');
    });
});

describe('measuring how far apart two sources are', () => {
    const a = [candle(base, 100, 110), candle(base + day, 100, 110)];
    const b = [candle(base, 100, 100), candle(base + day, 100, 100)];

    it('reports a disagreement on the high, which is what a channel is built from', () => {
        const gap = compareSources(a, b, 'test');

        // A high of 110 against 100 is a 10% gap, and a Donchian channel on one
        // of these is not a Donchian channel on the other.
        expect(gap.meanHighGap).toBeCloseTo(10, 9);
        expect(gap.worstHighGap).toBeCloseTo(10, 9);
        expect(gap.worstHighAt).toBe(base);
    });

    it('keeps the sign of the close gap, so one source being higher means something', () => {
        const higher = compareSources(a, [candle(base, 90, 100), candle(base + day, 90, 100)], 'x');

        expect(higher.meanCloseGap).toBeGreaterThan(0);
    });

    it('does not divide by zero on an empty overlap', () => {
        // The failure this guards: an unmatched series produced a table full of
        // confident 0.00% figures rather than an error.
        const empty = compareSources(a, [candle(base + 99 * day, 100)], 'x');

        expect(empty.bars).toBe(0);
        expect(empty.meanCloseGap).toBe(0);
        expect(empty.meanHighGap).toBe(0);
        expect(Number.isFinite(empty.worstHighGap)).toBe(true);
    });
});

describe('the same signal, tested on both series at once', () => {
    const rising = (n: number): Candle[] =>
        Array.from({ length: n }, (_, i) => candle(base + i * day, 100 + i));

    it('answers for each source separately rather than averaging them', () => {
        // A p-value is a statement about one series. Collapsing two venues into
        // one number would produce a figure about no series at all — which is
        // how a "confirmed on two sources" claim would be made by accident.
        const result = pValueOnBoth(
            (candles) => candles.map((_, i) => i % 3 === 0),
            rising(300),
            rising(300),
            100,
            200,
        );

        expect(result.a.p).toBeGreaterThan(0);
        expect(result.b.p).toBeGreaterThan(0);
        // 300 bars less the 100-bar warmup less the final bar, which has no
        // forward return to be scored against.
        expect(result.a.onCount + result.a.offCount).toBe(199);
    });

    it('takes a whole-series signal and aligns it, rather than trusting the caller', () => {
        // The first version asked for the measured window only, and a caller
        // that returned everything got a length mismatch — a loud failure, at
        // least, unlike the alternative of slicing the wrong end.
        const result = pValueOnBoth(
            (candles) => candles.map((_, i) => i % 3 === 0),
            rising(300),
            rising(150),
            100,
            100,
        );

        expect(result.a.onCount + result.a.offCount).toBe(199);
        expect(result.b.onCount + result.b.offCount).toBe(49);
    });

    it('drops the final signal, which has no forward return to be scored against', () => {
        // Counting it as a miss would put a bar the rule could not be judged
        // on into the denominator of the thing being measured. Nine bars, of
        // which five fire — the tenth is neither fire nor skip, it is absent.
        const result = pValueOnBoth(
            (candles) => candles.map((_, i) => i < 5),
            rising(10),
            rising(10),
            0,
            50,
        );

        expect(result.a.onCount).toBe(5);
        expect(result.a.offCount).toBe(4);
        expect(result.a.onCount + result.a.offCount).toBe(9);
    });
});
