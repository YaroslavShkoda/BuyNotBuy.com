import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { extractFeatures, extractFeatureSeries, requiredBarsForFeatures, DEFAULT_FEATURE_CONFIG } from './features.js';
import { buildDataset, datasetChecksum, splitByTime, summarize } from './dataset.js';

import type { Candle } from '../types/market.js';

/**
 * The suite's only real market data.
 *
 * Everything else here is a series built to be correct: constant percentage
 * drift, round numbers, no gaps, no weekend, no wick that is 8% of the body.
 * That is what makes a test readable and it is exactly why it cannot catch a
 * bug that needs the awkward cases — an EMA seeded on a market that gapped
 * overnight, a stochastic window that lands entirely inside a flat stretch, a
 * momentum calculation across a 30% drop.
 *
 * There is a real BTCUSDT daily file sitting in `backtest/fixtures/` that
 * nothing read until now, so the guarantees above were only ever checked on
 * data that was kind to them. This file loads it and re-checks the two that
 * matter: that a feature cannot see tomorrow, and that the dataset is
 * deterministic. If a synthetic series satisfies those because of how it was
 * built, this is what notices.
 */

const CSV = fileURLToPath(
    new URL('../backtest/fixtures/btcusdt-1d-binance.csv', import.meta.url),
);

function loadRealCandles(): Candle[] {
    const lines = readFileSync(CSV, 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0);

    const candles: Candle[] = [];

    for (let index = 1; index < lines.length; index += 1) {
        const [timestamp, open, high, low, close, volume] = lines[index]!.split(',');

        candles.push({
            timestamp: Number(timestamp),
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume),
        });
    }

    return candles;
}

const REAL = loadRealCandles();

describe('the real series is real', () => {
    it('has rows', () => {
        expect(REAL.length).toBeGreaterThan(2000);
    });

    it('is strictly increasing in time, so it is a series and not a set', () => {
        for (let index = 1; index < REAL.length; index += 1) {
            expect(REAL[index]!.timestamp).toBeGreaterThan(REAL[index - 1]!.timestamp);
        }
    });

    it('has every price inside its own bar', () => {
        // A synthetic series generated from a close almost never violates this,
        // so a parser bug or a bad conversion would hide here.
        for (const candle of REAL) {
            expect(candle.high).toBeGreaterThanOrEqual(candle.low);
            expect(candle.high).toBeGreaterThanOrEqual(candle.close);
            expect(candle.low).toBeLessThanOrEqual(candle.close);
        }
    });

    it('is not a straight line, which is the point of using it', () => {
        const closes = new Set(REAL.map((candle) => candle.close));

        expect(closes.size).toBeGreaterThan(REAL.length / 2);
    });
});

describe('the feature guarantees hold on a market that was not cooperative', () => {
    it('produces a finite vector at every index of the real series', () => {
        const vectors = extractFeatureSeries(REAL);

        expect(vectors.length).toBe(REAL.length - requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG) + 1);

        for (const vector of vectors) {
            for (const value of Object.values(vector.values)) {
                expect(Number.isFinite(value)).toBe(true);
            }
        }
    });

    it('does not let a vector see a bar that had not happened', () => {
        const cut = REAL.length - 40;

        fc.assert(
            fc.property(
                fc.integer({ min: requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG), max: cut - 1 }),
                (index) => {
                    const before = extractFeatures(REAL, index);

                    // The real market moved on after that bar. A feature that
                    // peeked forward would move with it, and a model trained
                    // on it would be learning from tomorrow.
                    const after = extractFeatures(
                        [...REAL, ...REAL.slice(-40)],
                        index,
                    );

                    expect(after.values).toEqual(before.values);
                },
            ),
            { numRuns: 30 },
        );
    });

    it('does move when a bar before the index is rewritten', () => {
        // The control. Without it, "nothing changed" would be satisfied by a
        // function that ignores its input.
        const cut = REAL.length - 5;
        const before = extractFeatures(REAL, cut);
        const rewritten = [...REAL];

        rewritten[1000] = { ...rewritten[1000]!, close: rewritten[1000]!.close * 2 };

        expect(extractFeatures(rewritten, cut).values).not.toEqual(before.values);
    });
});

describe('the dataset is deterministic on real data too', () => {
    it('builds the same checksum twice', () => {
        const vectors = extractFeatureSeries(REAL);

        expect(datasetChecksum(buildDataset(vectors, REAL))).toBe(
            datasetChecksum(buildDataset(vectors, REAL)),
        );
    });

    it('is never fully labelled, because the last horizon has not closed', () => {
        const rows = buildDataset(extractFeatureSeries(REAL), REAL);
        const summary = summarize(rows);

        expect(summary.unlabelled).toBeGreaterThan(0);
        expect(summary.labelled).toBeGreaterThan(0);
    });

    it('produces a split that purges and stays in order', () => {
        const rows = buildDataset(extractFeatureSeries(REAL), REAL);
        const split = splitByTime(rows, 0.6, 0.2);

        expect(split.purged).toBeGreaterThan(0);
        expect(Math.max(...split.train.map((r) => r.timestamp))).toBeLessThan(
            Math.min(...split.validation.map((r) => r.timestamp)),
        );
    });

    it('holds a label balance that is not degenerate', () => {
        const rows = buildDataset(extractFeatureSeries(REAL), REAL);
        const labelled = rows.filter((row) => row.label !== null);
        const share = labelled.filter((row) => row.label === 1).length / labelled.length;

        // A constant label would make every downstream measurement — every
        // accuracy, every confusion matrix, every walk-forward on this dataset
        // — meaningless, and it would look like a very good model.
        expect(share).toBeGreaterThan(0.4);
        expect(share).toBeLessThan(0.6);

        // The previous version asserted the share is *not* close to one half,
        // reasoning that eight years of Bitcoin rise should leave a lopsided
        // label. It passed on the Yahoo fixture at 0.536 and failed on the
        // Binance one at 0.505 — a difference of 0.0002 against a threshold of
        // 0.005, decided entirely by which instrument the file was pointed at.
        // A 50.5% share on a strongly rising market over a short horizon is the
        // expected base rate, not a sign that the label has stopped tracking
        // anything, and a test that can be flipped by swapping a data source is
        // a test measuring the source.
        //
        // The measured value is written down rather than asserted precisely:
        // 0.5048 on Binance BTCUSDT, 2096 bars from 2021-01-01. A change in it
        // is worth noticing, and asserting it to six digits would make the
        // fixture load-bearing for reasons that have nothing to do with the
        // code.
    });
});
