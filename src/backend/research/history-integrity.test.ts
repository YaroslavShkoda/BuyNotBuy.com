import { describe, expect, it } from 'vitest';

import type { Candle } from '../types/market.js';
import {
    auditCandleHistory,
    DEFAULT_OUTLIER_THRESHOLD,
    describeIntegrityReport,
    findCandleOutliers,
    findUtcGridMisalignment,
} from './history-integrity.js';

const HOUR = 3_600_000;

const bar = (index: number, close: number): Candle => ({
    timestamp: index * HOUR,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
});

const series = (count: number, close = 100): Candle[] =>
    Array.from({ length: count }, (_, index) => bar(index, close));

describe('the UTC grid check', () => {
    it('passes a series whose bars open on exact interval multiples', () => {
        expect(findUtcGridMisalignment(series(5), HOUR)).toEqual([]);
    });

    it('names a bar whose open time is off the grid, to the millisecond', () => {
        const candles = series(3);
        candles.splice(1, 1, { ...bar(1, 100), timestamp: HOUR + 1 });

        expect(findUtcGridMisalignment(candles, HOUR)).toEqual([HOUR + 1]);
    });
});

describe('the outlier scan', () => {
    it('flags a close-to-close move beyond the threshold', () => {
        const candles = [...series(3), bar(3, 150), bar(4, 150)];

        expect(findCandleOutliers(candles)).toEqual([
            { at: 3 * HOUR, move: 0.5, from: 100, to: 150 },
        ]);
    });

    it('passes moves at or below the threshold', () => {
        const candles = [...series(3), bar(3, 125), bar(4, 125)];

        expect(findCandleOutliers(candles)).toEqual([]);
    });

    it('orders several outliers largest first, and honours a custom threshold', () => {
        const candles = [...series(2), bar(2, 160), bar(3, 160), bar(4, 220)];

        const outliers = findCandleOutliers(candles);

        expect(outliers.map((outlier) => outlier.move)).toEqual([
            (160 / 100) - 1,
            (220 / 160) - 1,
        ]);

        expect(findCandleOutliers(candles, 2)).toEqual([]);
    });

    it('flags a close collapsing to zero, and does not divide by a zero earlier close', () => {
        const candles = [...series(2), bar(2, 0), bar(3, 0)];

        // 100 → 0 is the anomaly, named once. The bar after it has a zero
        // earlier close: there is no fraction to compute, and inventing one
        // would be louder than the move it measured.
        expect(findCandleOutliers(candles)).toEqual([
            { at: 2 * HOUR, move: 1, from: 100, to: 0 },
        ]);
    });
});

describe('the audit', () => {
    it('reports a clean aligned series with no findings', () => {
        const report = auditCandleHistory(series(48), HOUR);

        expect(report).toMatchObject({
            bars: 48,
            firstBarAt: 0,
            lastBarAt: 47 * HOUR,
            structuralIssue: null,
            misaligned: [],
            outliers: [],
            intervalMs: HOUR,
            outlierThreshold: DEFAULT_OUTLIER_THRESHOLD,
        });
    });

    it('surfaces structural problems in the series validator vocabulary', () => {
        const withDuplicate = [...series(3), bar(2, 100)];

        expect(auditCandleHistory(withDuplicate, HOUR).structuralIssue).toBe('duplicate');

        const withGap = [...series(2), bar(3, 100)];

        expect(auditCandleHistory(withGap, HOUR).structuralIssue).toBe('has_gap');

        const unsorted = [bar(1, 100), bar(0, 100), bar(2, 100)];

        expect(auditCandleHistory(unsorted, HOUR).structuralIssue).toBe('not_increasing');
    });

    it('does not ask freshness of a stored series, which is old by definition', () => {
        // A series whose newest bar is years before any "now" would fail the
        // live check as stale. The audit runs the validator's historical mode,
        // so age alone is not a finding.
        const ancient = Array.from({ length: 5 }, (_, index) => bar(index, 100));

        expect(auditCandleHistory(ancient, HOUR).structuralIssue).toBeNull();
    });

    it('reports an empty series instead of throwing on it', () => {
        const report = auditCandleHistory([], HOUR);

        expect(report).toMatchObject({
            bars: 0,
            firstBarAt: null,
            lastBarAt: null,
            structuralIssue: 'empty',
        });
    });

    it('reads the series without repairing it: the input is untouched', () => {
        // Frozen input, so any sort, filter or rewrite of the array or its
        // bars throws in strict mode. The audit reports; it does not fix.
        const candles = Object.freeze([
            Object.freeze(bar(0, 100)),
            Object.freeze({ ...bar(1, 100), timestamp: HOUR + 500 }),
        ]) as unknown as Candle[];

        expect(() => auditCandleHistory(candles, HOUR)).not.toThrow();
        expect(candles[1]?.timestamp).toBe(HOUR + 500);
    });

    it('describes itself in lines a person can check by hand', () => {
        const lines = describeIntegrityReport(auditCandleHistory(series(4), HOUR));

        expect(lines.some((line) => line.includes('баров: 4'))).toBe(true);
        expect(lines.some((line) => line.includes('целостна'))).toBe(true);
        expect(lines.some((line) => line.includes('выровнена'))).toBe(true);
        expect(lines.some((line) => line.includes('выбросы'))).toBe(true);
    });
});
