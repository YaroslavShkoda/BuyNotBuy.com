import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import type { DatasetRow } from './dataset.js';
import {
    buildDataset,
    DatasetRowSchema,
    datasetChecksum,
    labelFor,
    splitByTime,
    summarize,
    toMatrix,
} from './dataset.js';
import { extractFeatureSeries } from './features.js';

const HOUR = 3_600_000;

function series(count: number, drift = 0.001, intervalMs = HOUR): Candle[] {
    const newestOpen = Math.floor(Date.now() / intervalMs) * intervalMs;
    let close = 50_000;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
        close = close * (1 + drift);

        candles.push({
            timestamp: newestOpen - (count - 1 - index) * intervalMs,
            open: close / (1 + drift),
            high: close * 1.002,
            low: close * 0.998,
            close,
            volume: 1000 + index,
        });
    }

    return candles;
}

function row(timestamp: number, horizonBars = 24): DatasetRow {
    return {
        features: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        label: 1,
        timestamp,
        symbol: 'BTCUSDT',
        regime: 'TREND_UP',
        outcome: 0.01,
        horizonBars,
        featureVersion: 'f1',
        datasetVersion: 'ds1',
    };
}

describe('a label is allowed to look forward, and that is the whole problem', () => {
    it('reads the price after the horizon, not the one on the row', () => {
        const candles = series(60, 0.01);

        // Signed on the return. A label that agreed with the features would
        // carry nothing a model could not read off them.
        expect(labelFor(candles, 10, 24).label).toBe(1);
        expect(labelFor(series(60, -0.01), 10, 24).label).toBe(0);
    });

    it('keeps a row whose horizon has not closed, with no answer', () => {
        const candles = series(30);
        const { label, outcome } = labelFor(candles, 29, 24);

        // Dropping it would quietly bias the dataset toward periods where the
        // market happened to keep moving.
        expect(label).toBeNull();
        expect(outcome).toBeNull();
    });
});

describe('a row is self-describing, or it is not comparable to anything', () => {
    it('validates against its own schema', () => {
        const candles = series(500);
        const rows = buildDataset(extractFeatureSeries(candles), candles);

        expect(() => DatasetRowSchema.parse(rows[0])).not.toThrow();
    });

    it('carries the feature version and the dataset version', () => {
        const candles = series(500);
        const vectors = extractFeatureSeries(candles);
        const rows = buildDataset(vectors, candles);

        expect(rows[0]?.featureVersion).toBe(vectors[0]?.version);
        expect(rows[0]?.datasetVersion).toBe('ds1');
    });

    it('holds its features in the declared column order', () => {
        const candles = series(500);
        const vectors = extractFeatureSeries(candles);
        const rows = buildDataset(vectors, candles);

        // A map here would let a row be reordered, and a reordered row is a
        // row whose columns now mean something else.
        expect(rows[0]?.features).toEqual(Object.values(vectors[0]!.values));
    });

    it('builds the same dataset twice for the same candles', () => {
        const candles = series(500);

        expect(datasetChecksum(buildDataset(extractFeatureSeries(candles), candles))).toBe(
            datasetChecksum(buildDataset(extractFeatureSeries(candles), candles)),
        );
    });

    it('notices when the dataset is not the one it was', () => {
        const candles = series(500);
        const before = datasetChecksum(buildDataset(extractFeatureSeries(candles), candles));
        const after = datasetChecksum(
            buildDataset(extractFeatureSeries(series(500, 0.01)), series(500, 0.01)),
        );

        expect(before).not.toBe(after);
    });
});

describe('a row count is not a time boundary', () => {
    it('puts every train row before every validation row', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR));
        const split = splitByTime(rows, 0.6, 0.2);

        fc.assert(
            fc.property(fc.constant(0), () => {
                expect(
                    Math.max(...split.train.map((entry) => entry.timestamp)),
                ).toBeLessThan(Math.min(...split.validation.map((entry) => entry.timestamp)));

                return true;
            }),
            { numRuns: 1 },
        );
    });

    it('orders the rows before dividing, whatever order they arrive in', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR));
        const shuffled = [...rows].reverse();

        expect(splitByTime(shuffled).boundary).toEqual(splitByTime(rows).boundary);
    });

    it('leaves the test set whole, because it is only read once', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR));
        const split = splitByTime(rows, 0.6, 0.2);

        // 100 rows, 60% train, 20% validation leaves 20 for the test set,
        // and the test set is never purged: purging exists so a model cannot
        // learn from prices it will be judged on, and the test set is not
        // something it is ever judged on.
        expect(split.test).toHaveLength(20);
    });
});

describe('a training row whose answer is a test-period price has seen the test', () => {
    it('drops it rather than counting it as training data', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR, 24));
        const split = splitByTime(rows, 0.6, 0.2);

        // Keeping these is the most common way a time-series model reports a
        // number that will not reproduce in production, and it is invisible in
        // every metric: the fit gets better, not worse.
        const validationStart = split.boundary.validation;

        for (const entry of split.train) {
            expect(entry.timestamp + entry.horizonBars * HOUR).toBeLessThan(
                validationStart,
            );
        }
    });

    it('says how many it dropped, because a quiet loss reads as a dataset size', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR, 24));
        const split = splitByTime(rows, 0.6, 0.2);

        expect(split.purged).toBeGreaterThan(0);
    });

    it('purges nothing when the horizon is shorter than a bar', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR, 0));
        const split = splitByTime(rows, 0.6, 0.2);

        expect(split.purged).toBe(0);
        expect(split.train).toHaveLength(60);
    });

    it('purges by the interval it is told, not by an assumed hour', () => {
        const rows = Array.from({ length: 100 }, (_, index) =>
            row(index * 60_000, 24),
        );

        // On a minute series a 24-bar horizon is 24 minutes, so far less is
        // purged than on an hourly one. Carrying the interval rather than
        // assuming an hour is the difference between purging the right number
        // of rows and purging an arbitrary one.
        const hourly = splitByTime(rows, 0.6, 0.2, HOUR);
        const minutely = splitByTime(rows, 0.6, 0.2, 60_000);

        expect(hourly.purged).toBeGreaterThan(minutely.purged);
    });

    it('applies the same rule between validation and test', () => {
        const rows = Array.from({ length: 100 }, (_, index) => row(index * HOUR, 24));
        const split = splitByTime(rows, 0.6, 0.2);

        for (const entry of split.validation) {
            expect(entry.timestamp + entry.horizonBars * HOUR).toBeLessThan(
                split.boundary.test,
            );
        }
    });
});

describe('an unlabelled row is dropped from a matrix by default', () => {
    it('does not invent a label for it', () => {
        const rows = [
            { ...row(0), label: 1 },
            { ...row(1 * HOUR), label: null, outcome: null },
        ];
        const matrix = toMatrix(rows);

        // Inventing one is the most effective way to build a model that looks
        // trained and is not.
        expect(matrix.rows).toBe(1);
        expect(matrix.y).toEqual([1]);
    });

    it('keeps it when the caller says to, and still gives it a number', () => {
        const rows = [{ ...row(0), label: 1 }, { ...row(HOUR), label: null }];
        const matrix = toMatrix(rows, { dropUnlabelled: false });

        expect(matrix.rows).toBe(2);
        expect(matrix.y).toEqual([1, 0]);
    });

    it('names the columns it produced', () => {
        expect(toMatrix([row(0)]).featureNames).toHaveLength(13);
    });

    it('keeps exactly the labelled rows of any split, and no others', () => {
        const candles = series(600);
        const rows = buildDataset(extractFeatureSeries(candles), candles);
        const split = splitByTime(rows);

        // The test split is at the end of the series, so its last rows have
        // horizons that have not closed and the matrix legitimately holds
        // fewer rows than the split. Those rows are the difference.
        expect(toMatrix(split.train).rows).toBe(
            split.train.filter((entry) => entry.label !== null).length,
        );
        expect(toMatrix(split.test).rows).toBeLessThan(split.test.length);
        expect(toMatrix(split.train).rows).toBeGreaterThan(0);
    });
});

describe('a summary is what somebody would have guessed at', () => {
    it('counts what is labelled and what is not', () => {
        const candles = series(500);
        const rows = buildDataset(extractFeatureSeries(candles), candles);
        const summary = summarize(rows);

        // The last rows have horizons that have not closed, so a dataset is
        // never fully labelled and pretending otherwise overstates it.
        expect(summary.labelled).toBeLessThan(summary.rows);
        expect(summary.unlabelled).toBeGreaterThan(0);
        expect(summary.labelled + summary.unlabelled).toBe(summary.rows);
    });

    it('spans the whole series, oldest first', () => {
        const candles = series(500);
        const summary = summarize(buildDataset(extractFeatureSeries(candles), candles));

        expect(summary.from).toBeLessThan(summary.to);
    });

    it('summarises an empty dataset without inventing numbers', () => {
        const summary = summarize([]);

        expect(summary.rows).toBe(0);
        expect(summary.from).toBe(0);
        expect(summary.to).toBe(0);
        expect(summary.featureVersion).toBe('unknown');
    });
});
