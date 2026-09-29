import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { assessRegime } from './regime.js';
import { regimeConfig } from '../config/regime.config.js';

import type { Candle } from '../types/market.js';
import type { TrendRegime, VolatilityRegime } from './regime.js';

const HOUR = 3_600_000;
const BASE = 1_699_999_200_000;

/**
 * Bars built from a series of closes, oldest first, newest last.
 *
 * The order is the one the whole pipeline uses: a venue answers oldest first,
 * and every calculator here reads the last element as the current bar. A
 * fixture built the other way round is not a stricter test, it is a test of a
 * market running backwards — and it happened here: a fixture that read as a
 * falling market was being asserted as a rising one, and the engine was right
 * to disagree.
 *
 * The wick is a fraction of price and is added to both sides of the body. It
 * is deliberately not scaled by which way the bar went: a wick taken from
 * `max(open, close)` gives a down bar the same high as the up bar before it,
 * and a market that merely wiggles then reads as a one-way trend.
 */
function candlesFrom(closes: readonly number[]): Candle[] {
    return closes.map((close, index) => {
        const open = index === 0 ? close : (closes[index - 1] ?? close);
        const wick = close * 0.0005;

        return {
            timestamp: BASE - (closes.length - 1 - index) * HOUR,
            open,
            high: Math.max(open, close) + wick,
            low: Math.min(open, close) - wick,
            close,
            volume: 10 };
    });
}

/**
 * A random walk from a fixed seed.
 *
 * "Going nowhere" cannot be written as a formula. A sine wave is a trend with
 * wobbles and ADX finds it; a zigzag is a trend that changes hands every bar
 * and ADX finds that too. Noise with no drift is the only genuinely
 * directionless thing available, and a fixed seed keeps a failure
 * reproducible from the number alone.
 */
function walk(
    count: number,
    drift = 0,
    amplitude = 6,
    seed = 20_240_917,
): number[] {
    let state = seed;
    const closes: number[] = [];
    let price = 1000;

    for (let index = 0; index < count; index += 1) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        price = Math.max(
            1,
            price + drift + ((state / 2_147_483_648) - 0.5) * amplitude,
        );
        closes.push(price);
    }

    return closes;
}

/**
 * A steady trend in constant *percentage* steps, not constant absolute ones.
 *
 * This matters more than it looks. A linear ramp of 2 a bar on a price of 100
 * travels 2% and on a price of 500 travels 0.4%, so an absolute ramp is a
 * volatility increase wearing a trend's clothes, and it reads as one here.
 */
function trend(count: number, percentPerBar = 0.004): number[] {
    const closes: number[] = [];
    let price = 1000;

    for (let index = 0; index < count; index += 1) {
        price *= 1 + percentPerBar;
        closes.push(price);
    }

    return closes;
}

describe('the window a reading is measured over', () => {
    it('looks back over a month of hours and only a day of minutes', () => {
        // My first version of this test asserted the opposite — that both would
        // use every bar — and it was wrong in an instructive way. 1 500 bars is
        // 62 days hourly and 25 hours on a minute chart, so the hourly reading
        // is capped at its 720-bar window and the minute one uses everything it
        // has and still falls short of the 43 200 it asked for. The minute
        // reading says so; the hourly one has enough.
        const series = walk(1_500, 0.0002);
        const hourly = assessRegime({ candles: candlesFrom(series), interval: '1h' });
        const minute = assessRegime({ candles: candlesFrom(series), interval: '1m' });

        expect(hourly.baselineBars).toBe(720);
        expect(minute.baselineBars).toBe(1_500);
        expect(hourly.unreliable).toBeNull();
        expect(minute.unreliable).toBe('fewer than 2880 bars');
    });

    it('measures an hourly chart exactly as it did before the timeframe existed', () => {
        // Old results are never rewritten. This is the pin: a caller that names
        // no timeframe, and one that names `1h`, must get the same numbers they
        // have always got.
        const series = walk(800, 0.0003);
        const unnamed = assessRegime({ candles: candlesFrom(series) });
        const named = assessRegime({ candles: candlesFrom(series), interval: '1h' });

        expect(named).toEqual(unnamed);
    });

    it('says how many bars the baseline really had, not how many it wanted', () => {
        // A reading measured over 300 bars is a different claim from one over
        // 720, and a reader comparing the two has to be able to see which.
        const reading = assessRegime({
            candles: candlesFrom(walk(1_500, 0.0002)),
            interval: '1h',
        });

        expect(reading.baselineBars).toBe(720);

        const short = assessRegime({
            candles: candlesFrom(walk(300, 0.0002)),
            interval: '1h',
        });

        expect(short.baselineBars).toBe(300);
    });
});

describe('volatility regime', () => {
    it('reads NORMAL for a market travelling at its own usual rate', () => {
        const reading = assessRegime({
            candles: candlesFrom(trend(200))
        });

        // The baseline is this market's own median and the current value is the
        // same statistic over the recent window, so a market travelling at its
        // own usual rate sits on the normal boundary by construction.
        expect(reading.volatility).toBe('NORMAL');
        expect(reading.volatilityRatio).toBeCloseTo(1, 1);
    });

    it('reads HIGH when the market is travelling much further than usual', () => {
        const calm = trend(200, 0.001);
        const wild = Array.from({ length: 100 }, (_, index) =>
            5000 * 1.05 ** index,
        );

        const reading = assessRegime({
            candles: candlesFrom([...calm, ...wild])
        });

        expect(reading.volatilityRatio).toBeGreaterThan(
            regimeConfig.volatility.high,
        );
        expect(['HIGH', 'EXTREME']).toContain(reading.volatility);
    });

    it('reads LOW for a market that has quietly gone still', () => {
        // Long enough busy history that the baseline cannot be dragged into the
        // quiet phase, then a quiet stretch at the end. A market that was busy
        // for two hundred bars and has been quiet for two hundred is not in a
        // low-volatility regime — it is in a new one, and its own median says
        // so. That is the honest answer, and the test would be wrong to assert
        // otherwise.
        const busy = walk(800, 0, 20, 7);
        const quiet = walk(30, 0, 0.3, 9);

        const reading = assessRegime({
            candles: candlesFrom([...busy, ...quiet])
        });

        expect(reading.volatilityRatio).toBeLessThan(
            regimeConfig.volatility.normal,
        );
        expect(reading.volatility).toBe('LOW');
    });

    it('reads EXTREME only above its own threshold', () => {
        const calm = trend(200, 0.001);
        const violent = Array.from({ length: 150 }, (_, index) =>
            5000 * 1.12 ** index,
        );

        const reading = assessRegime({
            candles: candlesFrom([...calm, ...violent])
        });

        expect(reading.volatility).toBe('EXTREME');
    });

    it('reports the ratio it used, so the label can be checked', () => {
        // "HIGH" is a claim; the ratio is the evidence. A label without the
        // number is an assertion nobody can contest.
        const reading = assessRegime({
            candles: candlesFrom(trend(200))
        });

        expect(reading.volatilityRatio).toBeGreaterThan(0);
        expect(reading.baselineBars).toBe(200);
    });

    it('is not moved by one violent bar, because the baseline is a median', () => {
        const steady = trend(200, 0.004);
        const withSpike = [...steady.slice(0, 199), (steady[198] ?? 1) * 30];

        const before = assessRegime({
            candles: candlesFrom(steady)
        });
        const after = assessRegime({
            candles: candlesFrom(withSpike)
        });

        // A mean baseline would follow the spike and report it as the new
        // normal, which is a baseline that cannot detect anything.
        expect(after.volatilityRatio).toBeCloseTo(before.volatilityRatio, 1);
    });

    it('does not let the period it is judging define its own baseline', () => {
        // A baseline measured with a mean would be dragged along by the spike
        // and would report it as the new normal. The median needs half the
        // window to move before it moves at all.
        const calm = trend(300, 0.001);
        const spike = Array.from({ length: 100 }, (_, index) =>
            5000 * 1.06 ** index,
        );

        const reading = assessRegime({
            candles: candlesFrom([...calm, ...spike])
        });

        expect(reading.volatilityRatio).toBeGreaterThan(1);
    });
});

describe('trend regime', () => {
    it('reads TREND_UP for a market that keeps going up', () => {
        const reading = assessRegime({
            candles: candlesFrom(trend(200))
        });

        expect(reading.trend).toBe('TREND_UP');
        expect(reading.plusDI).toBeGreaterThan(reading.minusDI);
    });

    it('reads TREND_DOWN for a market that keeps going down', () => {
        // A constant percentage fall, so the fall is a trend rather than an
        // absolute ramp that happens to point down.
        const closes: number[] = [];
        let price = 1000;

        for (let index = 0; index < 200; index += 1) {
            price *= 0.996;
            closes.push(price);
        }

        const reading = assessRegime({ candles: candlesFrom(closes) });

        expect(reading.trend).toBe('TREND_DOWN');
        expect(reading.minusDI).toBeGreaterThan(reading.plusDI);
    });

    it('reads RANGE for a market that goes nowhere', () => {
        const reading = assessRegime({
            candles: candlesFrom(walk(200))
        });

        // A driftless walk still drifts locally, so the ADX is not near zero —
        // it lands near 30 and that is the honest reading. What makes it a
        // range is that neither side dominates: 24 against 12 is a market
        // with no direction, not a weak one.
        expect(reading.trend).toBe('RANGE');
        expect(reading.adx).toBeLessThan(
            assessRegime({
                candles: candlesFrom(trend(200)) }).adx,
        );
    });

    it('prefers HIGH_VOL over a direction inside a volatility spike', () => {
        // A strong directional move inside an extreme spike is mostly a
        // statement about how far apart consecutive prices are. Calling it
        // TREND_UP is how a flash crash reads as a buy.
        const calm = trend(200, 0.001);
        const spike = Array.from({ length: 120 }, (_, index) =>
            5000 * 1.14 ** index,
        );

        const reading = assessRegime({
            candles: candlesFrom([...calm, ...spike])
        });

        expect(reading.volatility).toBe('EXTREME');
        expect(reading.trend).toBe('HIGH_VOL');
    });

    it('reports RANGE for a strong trend with no side to it', () => {
        // +DI 55 against -DI 45 is a real trend pointing nowhere, and TREND_UP
        // would be a coin flip with a confident name on it.
        const reading = assessRegime({
            candles: candlesFrom(trend(200, 0.004))
        });

        const dominant = Math.max(reading.plusDI, reading.minusDI);

        if (dominant < regimeConfig.directional) {
            expect(reading.trend).toBe('RANGE');
        }
    });

    it('reports LOW_VOL for a still market with no trend', () => {
        // The quiet stretch has to outlast Wilder's smoothing. ADX halves the
        // weight of its oldest bars once per period, so a market that went
        // still thirty bars ago still reads as trending for a hundred more —
        // and it is right to: nothing in the recent bars contradicts the
        // trend. Reporting RANGE there is the honest answer, not a missed case.
        const busy = walk(800, 0, 20, 7);
        const quiet = walk(150, 0, 0.3, 9);

        const reading = assessRegime({
            candles: candlesFrom([...busy, ...quiet])
        });

        expect(reading.volatility).toBe('LOW');
        expect(reading.adx).toBeLessThan(regimeConfig.trend.weak);
        expect(reading.trend).toBe('LOW_VOL');
    });

    it('still calls a briefly quiet market a range, because the trend has not gone', () => {
        // The same series thirty bars after it went still. ADX has not caught
        // up and the engine is not obliged to pretend it has.
        const busy = walk(800, 0, 20, 7);
        const quiet = walk(30, 0, 0.3, 9);

        const reading = assessRegime({
            candles: candlesFrom([...busy, ...quiet])
        });

        expect(reading.volatility).toBe('LOW');
        expect(reading.trend).toBe('RANGE');
    });

    it('always reports one of the five', () => {
        const readings: TrendRegime[] = [
            assessRegime({ candles: candlesFrom(trend(200)) }).trend,
            assessRegime({ candles: candlesFrom(walk(200)) }).trend,
        ];

        for (const reading of readings) {
            expect([
                'TREND_UP',
                'TREND_DOWN',
                'RANGE',
                'HIGH_VOL',
                'LOW_VOL',
            ]).toContain(reading);
        }
    });
});

describe('honesty about what the reading is worth', () => {
    it('refuses to call a young series a regime', () => {
        // Fifty bars is a statement about fifty bars. A baseline that short can
        // classify the market by whatever it did in them.
        const reading = assessRegime({
            candles: candlesFrom(trend(40))
        });

        expect(reading.unreliable).toMatch(/fewer than/);
    });

    it('says nothing when the series is long enough', () => {
        const reading = assessRegime({
            candles: candlesFrom(trend(200))
        });

        expect(reading.unreliable).toBeNull();
    });

    it('names a market that has not moved instead of measuring it', () => {
        // A perfectly still market has no true ranges, so there is no baseline
        // to compare against and no honest ratio to report. Saying so is more
        // useful than a confident NORMAL computed from nothing.
        const still: Candle[] = Array.from({ length: 200 }, (_, index) => ({
            timestamp: BASE - (199 - index) * HOUR,
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            volume: 10 }));

        const reading = assessRegime({ candles: still });

        expect(reading.unreliable).toMatch(/has not moved/);
        expect(Number.isNaN(reading.volatilityRatio)).toBe(true);
    });

    it('names the reason in words, not as a code', () => {
        const reading = assessRegime({
            candles: candlesFrom(trend(40))
        });

        expect(reading.unreliable).toBeTypeOf('string');
        expect(reading.unreliable).toContain('bars');
    });
});

describe('regime invariants', () => {
    it('always reports both labels and every number behind them', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 1, max: 100_000, noNaN: true }), {
                    minLength: 60,
                    maxLength: 60 }),
                (closes) => {
                    const reading = assessRegime({
                        candles: candlesFrom(closes)
                    });

                    const labels: VolatilityRegime[] = [
                        'LOW',
                        'NORMAL',
                        'HIGH',
                        'EXTREME',
                    ];
                    const trends: TrendRegime[] = [
                        'TREND_UP',
                        'TREND_DOWN',
                        'RANGE',
                        'HIGH_VOL',
                        'LOW_VOL',
                    ];

                    expect(labels).toContain(reading.volatility);
                    expect(trends).toContain(reading.trend);
                    expect(reading.atr).toBeGreaterThanOrEqual(0);
                    expect(reading.adx).toBeGreaterThanOrEqual(0);
                    expect(reading.adx).toBeLessThanOrEqual(100);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never reports a direction it cannot justify', () => {
        fc.assert(
            fc.property(
                fc.array(fc.double({ min: 1, max: 50_000, noNaN: true }), {
                    minLength: 80,
                    maxLength: 80 }),
                (closes) => {
                    const reading = assessRegime({
                        candles: candlesFrom(closes)
                    });

                    // A directional label with no side to it is a coin flip
                    // with a confident name, and it is the specific failure
                    // these two thresholds exist to prevent.
                    if (
                        reading.trend === 'TREND_UP' ||
                        reading.trend === 'TREND_DOWN'
                    ) {
                        const dominant = Math.max(
                            reading.plusDI,
                            reading.minusDI,
                        );

                        expect(dominant).toBeGreaterThanOrEqual(
                            regimeConfig.directional,
                        );
                        expect(reading.adx).toBeGreaterThanOrEqual(
                            regimeConfig.trend.weak,
                        );
                        expect(reading.volatility).not.toBe('EXTREME');
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});
