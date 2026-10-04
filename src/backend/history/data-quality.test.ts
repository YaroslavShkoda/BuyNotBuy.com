import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market.js';
import {
    assessDataQuality,
    DEFAULT_REQUIRED_BARS,
    describeSeries,
    qualityFloor,
} from './data-quality.js';

const HOUR = 3_600_000;
const BOUNDARY = 1_699_999_200_000;
const NOW = BOUNDARY + 30 * 60_000;

function bar(timestamp: number, close = 100): Candle {
    return {
        timestamp,
        open: close - 0.25,
        high: close + 1,
        low: close - 1.25,
        close,
        volume: 10,
    };
}

/** A whole number of hours ending at the newest bar. */
function contiguous(count: number, newest = BOUNDARY): Candle[] {
    return Array.from({ length: count }, (_, index) =>
        bar(newest - index * HOUR, 100 + index),
    );
}

function qualityFor(
    candles: Candle[],
    overrides: Partial<Parameters<typeof assessDataQuality>[0]> = {},
) {
    return assessDataQuality({
        candles,
        now: NOW,
        intervalMs: HOUR,
        provider: 'binance',
        ...overrides,
    });
}

function factorScore(
    quality: ReturnType<typeof assessDataQuality>,
    factor: string,
): number {
    return quality.factors.find((entry) => entry.factor === factor)?.score ?? -1;
}

describe('assessDataQuality', () => {
    it('scores a whole, recent series as usable', () => {
        const quality = qualityFor(contiguous(DEFAULT_REQUIRED_BARS));

        expect(quality.usable).toBe(true);
        expect(quality.blockedBy).toBeNull();
        expect(quality.score).toBe(1);
        expect(quality.floor).toBe(1);
    });

    it('names the five factors it was computed from', () => {
        const quality = qualityFor(contiguous(50));

        expect(quality.factors.map((entry) => entry.factor)).toEqual([
            'freshness',
            'coverage',
            'gaps',
            'venue',
            'validation',
        ]);
    });

    describe('freshness', () => {
        it('is full when the newest bar is the one in progress', () => {
            const quality = qualityFor([
                ...contiguous(20),
                bar(BOUNDARY),
            ]);

            expect(factorScore(quality, 'freshness')).toBe(1);
        });

        it('is half when the newest bar is an interval behind', () => {
            // The newest finished bar, with the forming one missing: the
            // series is behind, which is a delay rather than an outage.
            const quality = qualityFor(contiguous(20, BOUNDARY - HOUR));

            expect(factorScore(quality, 'freshness')).toBe(0.5);
        });

        it('is zero when the newest bar is days old', () => {
            const stale = contiguous(20, BOUNDARY - 20 * HOUR);

            expect(factorScore(qualityFor(stale), 'freshness')).toBe(0);
        });

        it('is judged against the interval, not the cache TTL', () => {
            // The newest bar here is ninety minutes old, which is past
            // `maxStaleMs` and would make a cached snapshot unservable. The
            // series is still perfectly good to compute a signal from, and a
            // quality score that refused it would be measuring the cache
            // instead of the data.
            const quality = qualityFor(contiguous(20, BOUNDARY - HOUR));

            expect(factorScore(quality, 'freshness')).toBe(0.5);
            expect(factorScore(quality, 'coverage')).toBeLessThan(0.6);
            expect(quality.blockedBy).toBe('coverage');
        });

        it('honours a freshness state the snapshot path already decided', () => {
            const candles = contiguous(DEFAULT_REQUIRED_BARS);
            const good = qualityFor(candles);

            expect(good.usable).toBe(true);
            expect(good.freshness).toBeNull();

            const vetoed = qualityFor(candles, {
                snapshotFreshness: 'expired',
            });

            // The snapshot path has already refused to serve this, and a
            // quality score that outvoted it would leave two components
            // disagreeing about the same candles.
            expect(vetoed.freshness).toBe('expired');
            expect(vetoed.usable).toBe(false);
        });
    });

    describe('coverage', () => {
        it('is proportional to how many bars are there', () => {
            expect(factorScore(qualityFor(contiguous(50)), 'coverage')).toBeCloseTo(
                0.25,
                5,
            );
            expect(
                factorScore(qualityFor(contiguous(100)), 'coverage'),
            ).toBeCloseTo(0.5, 5);
        });

        it('is full once the warm-up is satisfied', () => {
            expect(
                factorScore(qualityFor(contiguous(400)), 'coverage'),
            ).toBe(1);
        });

        it('is zero for no bars at all', () => {
            expect(factorScore(qualityFor([]), 'coverage')).toBe(0);
        });
    });

    describe('gaps', () => {
        it('is full for a continuous series', () => {
            expect(factorScore(qualityFor(contiguous(50)), 'gaps')).toBe(1);
        });

        it('is penalised for a missing hour', () => {
            const withHole = [
                ...contiguous(20).filter(
                    (row) => row.timestamp !== BOUNDARY - 5 * HOUR,
                ),
            ];

            expect(factorScore(qualityFor(withHole), 'gaps')).toBeLessThan(1);
        });

        it('is what refuses the series, even when the mean looks fine', () => {
            const withHole = contiguous(400).filter(
                (row) => row.timestamp !== BOUNDARY - 5 * HOUR,
            );

            const quality = qualityFor(withHole);

            // The whole point of the floor. Four hundred bars, one missing, an
            // average that looks perfectly respectable — and the one missing
            // bar is the only thing that matters, because every indicator here
            // is a function of the distance between consecutive bars and will
            // step over it and report a well-formed number.
            expect(quality.score).toBeCloseTo(0.8, 5);
            expect(quality.floor).toBe(0);
            expect(quality.usable).toBe(false);
            expect(quality.worst).toBe('gaps');
            expect(quality.blockedBy).toBe('gaps');
        });

        it('is zero, not a deduction, for a single hole in a long series', () => {
            const withHole = contiguous(400).filter(
                (row) => row.timestamp !== BOUNDARY - 200 * HOUR,
            );

            // A hole in four hundred bars scores 0.0025 if gaps are a
            // proportion, and a score is something a caller may choose to
            // accept. A gap is not a matter of degree, and the existing
            // validator already treats it as an issue rather than a deduction.
            expect(factorScore(qualityFor(withHole), 'gaps')).toBe(0);
        });

        it('cannot judge gaps from a single bar', () => {
            // One bar has no neighbour to have a gap from, and scoring that as
            // perfect would be a clean bill of health for a series that says
            // nothing.
            expect(factorScore(qualityFor(contiguous(1)), 'gaps')).toBe(0);
        });
    });

    describe('venue', () => {
        it('is full for the primary answering', () => {
            expect(factorScore(qualityFor(contiguous(50)), 'venue')).toBe(1);
        });

        it('is reduced, not zero, for a fallback', () => {
            // A fallback's numbers are correct and its provenance is weaker: a
            // different venue's print of the same market, and a result measured
            // across a switch mixes two series. Enough to build on, not enough
            // to be indistinguishable from the primary.
            const quality = qualityFor(
                contiguous(DEFAULT_REQUIRED_BARS),
                { fallback: true },
            );

            expect(factorScore(quality, 'venue')).toBeGreaterThan(0.5);
            expect(quality.usable).toBe(true);
        });

        it('is zero when the venue is not answering', () => {
            const quality = qualityFor(contiguous(50), {
                providerAvailable: false,
            });

            expect(factorScore(quality, 'venue')).toBe(0);
            expect(quality.usable).toBe(false);
        });
    });

    describe('validation', () => {
        it('is full when nothing was rejected', () => {
            expect(
                factorScore(qualityFor(contiguous(50)), 'validation'),
            ).toBe(1);
        });

        it('counts rejected bars against the series, not absolutely', () => {
            const one = qualityFor(contiguous(1000), { validationIssues: 1 });
            const many = qualityFor(contiguous(50), { validationIssues: 25 });

            // One bad bar in a thousand is a rounding error; half the series is
            // not, and the two must not look alike.
            expect(factorScore(one, 'validation')).toBeCloseTo(0.999, 3);
            expect(factorScore(many, 'validation')).toBeCloseTo(0.5, 5);
        });
    });

    describe('the decision', () => {
        it('refuses a short series and says which factor refused it', () => {
            const quality = qualityFor(contiguous(20));

            expect(quality.usable).toBe(false);
            expect(quality.worst).toBe('coverage');
            expect(quality.blockedBy).toBe('coverage');
        });

        it('reports the same floor twice, in case one of them is what was read', () => {
            const quality = qualityFor(contiguous(20));

            expect(qualityFloor(quality)).toBe(quality.floor);
        });

        it('is the same decision for the same inputs', () => {
            const candles = contiguous(300);

            expect(qualityFor(candles)).toEqual(qualityFor(candles));
        });
    });

    describe('invariants', () => {
        it('never reports a score outside 0..1', () => {
            fc.assert(
                fc.property(
                    fc.array(fc.integer({ min: 0, max: 400 }), {
                        minLength: 0,
                        maxLength: 12,
                    }),
                    fc.boolean(),
                    fc.boolean(),
                    fc.integer({ min: 0, max: 500 }),
                    (lengths, available, fallback, issues) => {
                        const candles: Candle[] = [];
                        let timestamp = BOUNDARY - HOUR;

                        for (const gap of lengths) {
                            // Gaps, so `gaps` is actually exercised rather than
                            // always scoring 1.
                            timestamp -= (gap + 1) * HOUR;
                            candles.push(bar(timestamp, 100 + timestamp % 7));
                        }

                        const quality = assessDataQuality({
                            candles,
                            now: NOW,
                            intervalMs: HOUR,
                            provider: 'binance',
                            providerAvailable: available,
                            fallback,
                            validationIssues: issues,
                        });

                        for (const factor of quality.factors) {
                            expect(factor.score).toBeGreaterThanOrEqual(0);
                            expect(factor.score).toBeLessThanOrEqual(1);
                        }

                        expect(quality.score).toBeGreaterThanOrEqual(0);
                        expect(quality.score).toBeLessThanOrEqual(1);
                        expect(quality.floor).toBeLessThanOrEqual(quality.score);
                    },
                ),
                { numRuns: 300 },
            );
        });

        it('never says a series is usable while one factor is at zero', () => {
            fc.assert(
                fc.property(
                    fc.array(fc.integer({ min: 0, max: 300 }), {
                        minLength: 0,
                        maxLength: 8,
                    }),
                    fc.boolean(),
                    (lengths, available) => {
                        const candles: Candle[] = [];
                        let timestamp = BOUNDARY - HOUR;

                        for (const gap of lengths) {
                            timestamp -= (gap + 1) * HOUR;
                            candles.push(bar(timestamp, 100 + timestamp % 7));
                        }

                        const quality = assessDataQuality({
                            candles,
                            now: NOW,
                            intervalMs: HOUR,
                            provider: 'binance',
                            providerAvailable: available,
                        });

                        if (quality.usable) {
                            expect(quality.floor).toBeGreaterThanOrEqual(
                                0.6,
                            );
                        }
                    },
                ),
                { numRuns: 300 },
            );
        });

        it('scores a series with no bars as unusable and blames what is missing', () => {
            const quality = qualityFor([]);

            expect(quality.usable).toBe(false);
            expect(quality.floor).toBe(0);
            expect(quality.score).toBe(0.4);

            // The venue being healthy and nothing having been rejected are
            // still true of an empty series, and reporting them as failures
            // would send whoever is looking to the wrong component.
            expect(factorScore(quality, 'venue')).toBe(1);
            expect(factorScore(quality, 'validation')).toBe(1);
            expect(factorScore(quality, 'freshness')).toBe(0);
            expect(factorScore(quality, 'coverage')).toBe(0);
        });
    });

    it('names a series the way it is stored', () => {
        expect(
            describeSeries({
                provider: 'binance',
                symbol: 'BTCUSDT',
                interval: '1h',
            }),
        ).toBe('binance:BTCUSDT:1h');
    });
});
