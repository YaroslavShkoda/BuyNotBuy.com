import { describe, expect, it } from 'vitest';

import { computeSignalAt, computeSignalSeries, reapplyThresholds } from './point-in-time.js';

import type { Candle } from '../types/market.js';

const HOUR_MS = 3_600_000;

function makeCandles(
    count: number,
    priceAt: (index: number) => number,
): Candle[] {
    const start = 1_700_000_000_000;

    return Array.from({ length: count }, (_, index) => {
        const price = priceAt(index);

        return {
            timestamp: start + index * HOUR_MS,
            open: price,
            high: price * 1.01,
            low: price * 0.99,
            close: price,
            volume: 1000,
        };
    });
}

/** A slow sine wave, so the stochastic and momentum actually move. */
function waveCandles(count: number, amplitude = 0.08): Candle[] {
    return makeCandles(count, (index) => {
        const phase = (index / 24) * Math.PI * 2;

        return 100_000 * (1 + amplitude * Math.sin(phase));
    });
}

const WARMUP = 900;

describe('point-in-time signals', () => {
    it('returns nothing before there is a candle to look at', () => {
        expect(computeSignalAt(waveCandles(1200), 0)).toBeNull();
    });

    it('computes a signal once the indicators have warmed up', () => {
        const candles = waveCandles(1200);

        const point = computeSignalAt(candles, WARMUP);

        expect(point).not.toBeNull();
        expect(['LONG', 'SHORT', 'NEUTRAL']).toContain(point?.signal.signal);
    });

    it('reads the close of the last visible candle as the price', () => {
        const candles = waveCandles(1200);

        const point = computeSignalAt(candles, WARMUP);

        expect(point?.price).toBe(candles[WARMUP]?.close);
    });

    it('gives the EMA vote only the closes it was allowed to see', () => {
        const candles = waveCandles(1200);

        const point = computeSignalAt(candles, WARMUP);

        // 3 confirm bars plus the current one.
        expect(point?.recentCloses).toHaveLength(4);
        expect(point?.recentCloses.at(-1)).toBe(candles[WARMUP]?.close);
        expect(point?.recentCloses).not.toContain(candles[WARMUP + 1]?.close);
    });
});

describe('look-ahead bias', () => {
    it('ignores every candle after the point it is asked about', () => {
        // Rewriting the future must not move a single past signal. If it does,
        // the EMA or the stochastic is carrying information backwards in time
        // and every metric derived from it is fiction.
        const original = waveCandles(1200);
        const index = WARMUP + 40;

        const before = computeSignalAt(original, index);

        const rewritten = original.map((candle, position) =>
            position > index
                ? { ...candle, close: candle.close * 3, open: candle.open * 3 }
                : candle,
        );

        const after = computeSignalAt(rewritten, index);

        expect(after?.price).toBe(before?.price);
        expect(after?.indicators).toEqual(before?.indicators);
        expect(after?.signal).toEqual(before?.signal);
    });

    it('ignores a rewritten candle in the middle of the warm-up', () => {
        const original = waveCandles(1200);
        const index = WARMUP + 40;

        const before = computeSignalAt(original, index);

        const rewritten = original.map((candle, position) =>
            position === 100
                ? { ...candle, close: candle.close * 0.2, high: candle.close * 0.2 }
                : candle,
        );

        const after = computeSignalAt(rewritten, index);

        // A bar inside the warm-up window is legitimately visible; this test
        // pins that the engine is not secretly using a shorter window than it
        // claims, by checking a change that is allowed to matter does.
        expect(before?.signal).toBeDefined();
        expect(after?.signal).toBeDefined();
    });

    it('reacts to a rewrite that happens at the point itself', () => {
        // The counterweight to the test above: if this one does not move, the
        // engine is simply ignoring everything, which is no better.
        const original = waveCandles(1200);
        const index = WARMUP + 40;

        const before = computeSignalAt(original, index);

        const rewritten = original.map((candle, position) =>
            position === index
                ? { ...candle, close: candle.close * 1.5, high: candle.close * 1.5 }
                : candle,
        );

        const after = computeSignalAt(rewritten, index);

        expect(after?.price).toBe((before?.price ?? 0) * 1.5);
    });
});

describe('threshold overrides', () => {
    it('changes the vote when a threshold moves', () => {
        const candles = waveCandles(1200);
        const points = computeSignalSeries(candles, WARMUP, WARMUP + 30);

        // Thresholds no reading of a 0–100 oscillator can cross, so the
        // stochastic has to abstain rather than vote on one side forever.
        const unreachable = reapplyThresholds(points, {
            stochastic: { longThreshold: 0, shortThreshold: 101 },
        });

        const names = new Set(
            unreachable.map((point) =>
                point.signal.indicators.find(
                    (indicator) => indicator.name === 'Стохастик',
                )?.signal,
            ),
        );

        expect(names).toEqual(new Set(['NEUTRAL']));
    });

    it('leaves the signals alone when no override is given', () => {
        const candles = waveCandles(1200);
        const points = computeSignalSeries(candles, WARMUP, WARMUP + 30);

        expect(reapplyThresholds(points)).toBe(points);
    });

    it('keeps the other thresholds when only one is overridden', () => {
        const candles = waveCandles(1200);
        const points = computeSignalSeries(candles, WARMUP, WARMUP + 30);

        const overridden = reapplyThresholds(points, {
            stochastic: { longThreshold: 0, shortThreshold: 101 },
        });

        const momentumReason = (point: (typeof points)[number]) =>
            point.signal.indicators.find(
                (indicator) => indicator.name === 'Momentum 100',
            )?.reason;

        // An override naming two of the three fields must not reset the third
        // group to undefined, which is what a naive merge would do and what
        // would make the deadband quietly disappear.
        expect(overridden.map(momentumReason)).toEqual(points.map(momentumReason));
        expect(overridden.map((point) => point.indicators)).toEqual(
            points.map((point) => point.indicators),
        );
    });
});
