import { describe, expect, it } from 'vitest';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import { calculateSignal } from './signal.service.js';

function indicators(overrides: Partial<MarketIndicators> = {}): MarketIndicators {
    return {
        ema: 100,
        stochastic: 50,
        momentum: 0,
        atr: 1,
        rsi: 50,
        macd: { macd: 0, signal: 0, histogram: 0 },
        ...overrides,
    };
}

function byKey(result: ReturnType<typeof calculateSignal>, key: string) {
    return result.indicators.find((item) => item.key === key);
}

describe('signal service: values that are not numbers', () => {
    it('reports an unusable momentum as unavailable rather than as SHORT', () => {
        const result = calculateSignal(100, indicators({ momentum: Number.NaN }), [
            100,
        ]);

        const momentum = byKey(result, 'momentum');

        // A comparison against NaN is false, so the deadband could not catch
        // it and the value fell through to the negative branch.
        expect(momentum?.signal).toBe('NEUTRAL');
        expect(momentum?.weight).toBe(0);
        expect(momentum?.reason).not.toMatch(/ниже 0|выше 0/);
    });

    it('reports an unusable EMA as unavailable', () => {
        const result = calculateSignal(100, indicators({ ema: Number.NaN }), [
            100,
        ]);

        const ema = byKey(result, 'ema');

        expect(ema?.signal).toBe('NEUTRAL');
        expect(ema?.weight).toBe(0);

        // Asserting only the signal and the weight would have passed against
        // the old code: a NaN average is never `> 0` and never `< 0`, so no
        // close counted as above or below it and the function fell through to
        // the "cannot hold a side" branch — a working indicator that merely
        // found nothing. The reason is what tells the two apart.
        expect(ema?.reason).toMatch(/недоступна/);
        expect(ema?.reason).not.toMatch(/не удерживается/);
    });

    it('reports an unusable stochastic as unavailable, not as neutral-zone', () => {
        const result = calculateSignal(100, indicators({ stochastic: Number.NaN }), [
            100,
        ]);

        const stochastic = byKey(result, 'stochastic');

        expect(stochastic?.signal).toBe('NEUTRAL');
        expect(stochastic?.weight).toBe(0);
        expect(stochastic?.reason).not.toMatch(/нейтральной зоне/);
    });

    it('never turns an unusable indicator into a directional headline', () => {
        for (const broken of [
            { momentum: Number.NaN },
            { ema: Number.NaN },
            { stochastic: Number.NaN },
            { momentum: Number.POSITIVE_INFINITY },
            { ema: Number.POSITIVE_INFINITY },
        ]) {
            const result = calculateSignal(100, indicators(broken), [100]);

            // A headline the dashboard would render as a tradeable opinion.
            expect(result.signal).toBe('NEUTRAL');
        }
    });
});

describe('signal service: a vote with no weight behind it', () => {
    it('does not let a zero-weight indicator carry a published signal', () => {
        // Price sitting exactly on the EMA, so its conviction is zero while
        // its direction is still LONG. The stochastic agrees, with real
        // weight. One real voter is one voter.
        const result = calculateSignal(
            100,
            indicators({ ema: 100, stochastic: 10, momentum: 0 }),
            [100],
        );

        expect(result.signal).toBe('NEUTRAL');
    });

    it('publishes a direction when two indicators carry real weight', () => {
        const result = calculateSignal(
            110,
            indicators({ ema: 100, stochastic: 10, momentum: 8 }),
            [110, 110, 110],
        );

        expect(result.signal).toBe('LONG');
        expect(result.confidence).toBeGreaterThan(0);
    });
});
