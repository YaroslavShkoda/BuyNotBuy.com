import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import {
    DEFAULT_FEATURE_CONFIG,
    extractFeatureSeries,
    extractFeatures,
    FEATURE_NAMES,
    FeatureVectorSchema,
    featureVersion,
    REGIME_LEVELS,
    regimeLevel,
    requiredBarsForFeatures,
} from './features.js';

const HOUR = 3_600_000;

/**
 * A series with a real, constant percentage drift.
 *
 * The percentages are constant rather than the absolute steps because an
 * absolute step is a different market at a different price: a series that
 * steps by 10 a bar is flat at 1000 and violent at 10000, and a feature
 * extractor that behaves differently on the two is not wrong so much as
 * unmeasurable. Anchored to the clock so the freshness checks see a series
 * that is updating.
 */
function series(count: number, drift = 0.001): Candle[] {
    const newestOpen = Math.floor(Date.now() / HOUR) * HOUR;
    let close = 50_000;
    const candles: Candle[] = [];

    for (let index = 0; index < count; index += 1) {
        close = close * (1 + drift);

        candles.push({
            timestamp: newestOpen - (count - 1 - index) * HOUR,
            open: close / (1 + drift),
            high: close * 1.002,
            low: close * 0.998,
            close,
            volume: 1000 + index,
        });
    }

    return candles;
}

describe('a feature vector is comparable only to one made the same way', () => {
    it('carries the definition that produced it', () => {
        const vector = extractFeatures(series(400), 399);

        expect(vector.version).toBe(featureVersion(DEFAULT_FEATURE_CONFIG));
    });

    it('changes the version when a period changes, because the meaning did', () => {
        const before = featureVersion(DEFAULT_FEATURE_CONFIG);
        const after = featureVersion({
            ...DEFAULT_FEATURE_CONFIG,
            emaPeriod: 200,
        });

        expect(after).not.toBe(before);
    });

    it('gives the same version to the same periods, whenever it is computed', () => {
        // A date would not do this: a date does not change when the code does,
        // and these are exactly the settings that decide what a vector means.
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 1000 }), () => {
                expect(featureVersion(DEFAULT_FEATURE_CONFIG)).toBe(
                    featureVersion({ ...DEFAULT_FEATURE_CONFIG }),
                );
            }),
            { numRuns: 10 },
        );
    });

    it('is finite everywhere, so no column is silently teaching a model NaN', () => {
        const vector = extractFeatures(series(400), 399);

        for (const name of FEATURE_NAMES) {
            expect(Number.isFinite(vector.values[name])).toBe(true);
        }
    });

    it('validates against its own schema', () => {
        expect(() =>
            FeatureVectorSchema.parse(extractFeatures(series(400), 399)),
        ).not.toThrow();
    });
});

describe('no feature may see a bar that had not happened yet', () => {
    it('does not change when bars are appended after the index', () => {
        const history = series(500);
        const before = extractFeatures(history, 499);

        // The market moved on after that bar. A feature that peeked forward
        // would move with it, and a model trained on it would be learning from
        // tomorrow.
        const extended = [...history, ...series(50, -0.004)];
        const after = extractFeatures(extended, 499);

        expect(after.values).toEqual(before.values);
        expect(after.timestamp).toBe(before.timestamp);
    });

    it('does not change when the bars after the index are rewritten entirely', () => {
        const history = series(500);
        const before = extractFeatures(history, 400);

        // A stronger version of the same check: replacing the future rather
        // than appending to it is what a shuffled dataset looks like, and it
        // is the failure this project has already shipped once.
        const rewritten = [...history.slice(0, 401), ...series(99, 0.05)];
        const after = extractFeatures(rewritten, 400);

        expect(after.values).toEqual(before.values);
    });

    it('holds for every index of a real series, not just the last one', () => {
        const history = series(600);
        const cut = 550;

        fc.assert(
            fc.property(
                fc.integer({ min: requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG), max: cut - 1 }),
                (index) => {
                    const before = extractFeatures(history, index);
                    const after = extractFeatures([...history, ...series(20, 0.02)], index);

                    expect(after.values).toEqual(before.values);
                },
            ),
            { numRuns: 40 },
        );
    });

    it('does change when a bar before the index is rewritten, which is the control', () => {
        // Without this, "nothing changes" would be satisfied by a function that
        // ignores its input entirely, and the leakage test would pass for the
        // wrong reason.
        const history = series(500);
        const before = extractFeatures(history, 499);

        const rewritten = history.slice();
        rewritten[300] = { ...rewritten[300]!, close: rewritten[300]!.close * 1.5 };

        expect(extractFeatures(rewritten, 499).values).not.toEqual(before.values);
    });
});

describe('a short window is refused rather than filled in', () => {
    it('names how many bars it needed', () => {
        const needed = requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG);

        expect(() => extractFeatures(series(needed - 1), needed - 1)).toThrow(
            new RegExp(String(needed)),
        );
    });

    it('accepts exactly the window it asked for', () => {
        const needed = requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG);

        expect(() => extractFeatures(series(needed), needed - 1)).not.toThrow();
    });

    it('binds on the MACD chain, not on the largest single period', () => {
        const config = { ...DEFAULT_FEATURE_CONFIG, macdSlowPeriod: 26, macdSignalPeriod: 9 };

        // The signal line is an EMA of the MACD line, so the MACD line has to
        // exist for signalPeriod bars before there is anything to smooth.
        expect(requiredBarsForFeatures(config)).toBeGreaterThanOrEqual(35);
    });
});

describe('a flat market produces zeros rather than an exception', () => {
    it('survives a window with no range at all', () => {
        const needed = requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG);
        const flat: Candle[] = Array.from({ length: needed }, (_, index) => ({
            timestamp: index * HOUR,
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 10,
        }));

        // Stochastic throws when highest high equals lowest low, which in a
        // flat market is a fact rather than a data error. Refusing the window
        // would delete exactly the stretches where a trend system is tested.
        const vector = extractFeatures(flat, needed - 1);

        for (const name of FEATURE_NAMES) {
            expect(Number.isFinite(vector.values[name])).toBe(true);
        }
    });
});

describe('the regime column is an encoding, and says so', () => {
    it('decodes back to a name the project already uses', () => {
        for (let code = 0; code < REGIME_LEVELS.length; code += 1) {
            expect(regimeLevel(code)).toBe(REGIME_LEVELS[code]);
        }
    });

    it('falls back rather than returning undefined for a stored oddity', () => {
        // A vector read back years later may carry a code this build no longer
        // knows. Undefined there would put a hole in a report.
        expect(regimeLevel(99)).toBe('RANGE');
        expect(regimeLevel(-1)).toBe('RANGE');
    });

    it('produces a code inside the declared range for any series', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 400, max: 460 }),
                fc.double({ min: -0.004, max: 0.004, noNaN: true }),
                (count, drift) => {
                    const vector = extractFeatures(series(count, drift), count - 1);

                    expect(vector.values.regime).toBeGreaterThanOrEqual(0);
                    expect(vector.values.regime).toBeLessThan(REGIME_LEVELS.length);
                },
            ),
            { numRuns: 25 },
        );
    });
});

describe('the series is the same vectors, oldest first', () => {
    it('skips the bars before the window exists', () => {
        const candles = series(500);
        const vectors = extractFeatureSeries(candles);

        expect(vectors).toHaveLength(
            500 - requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG) + 1,
        );
        expect(vectors[0]?.timestamp).toBe(
            candles[requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG) - 1]?.timestamp,
        );
    });

    it('agrees with the single-vector extractor at every index', () => {
        const candles = series(450);
        const vectors = extractFeatureSeries(candles);
        const start = requiredBarsForFeatures(DEFAULT_FEATURE_CONFIG) - 1;

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: vectors.length - 1 }),
                (offset) => {
                    expect(vectors[offset]?.values).toEqual(
                        extractFeatures(candles, start + offset).values,
                    );
                },
            ),
            { numRuns: 25 },
        );
    });

    it('gives the same series twice for the same candles', () => {
        const candles = series(430);

        expect(extractFeatureSeries(candles)).toEqual(extractFeatureSeries(candles));
    });
});
