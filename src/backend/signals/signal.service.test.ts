import { describe, expect, it } from 'vitest';

import { calculateSignal } from './signal.service.js';

import { INDICATOR_SIGNAL_CONFIG } from '../config/indicator.config.js';

const { confirmBars } = INDICATOR_SIGNAL_CONFIG.ema;
const { deadbandPercent } = INDICATOR_SIGNAL_CONFIG.momentum;

function closesAbove(price: number, count: number): number[] {
    return Array.from({ length: count }, () => price);
}

describe('calculateSignal', () => {
    it('requires the EMA vote to survive three consecutive closes', () => {
        // Price sits above the EMA right now, but only just turned. A single
        // print through an average is noise, and it used to move the headline
        // signal on every scan.
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 10,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            [77_000, 77_500, 80_000],
        );

        const ema = result.indicators.find(
            (indicator) => indicator.name === 'EMA 300',
        );

        expect(ema?.signal).toBe('NEUTRAL');
        expect(ema?.weight).toBe(0);
        expect(ema?.reason).toContain('не удерживается');
    });

    it('confirms the EMA vote once three closes agree', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 10,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            [79_000, 79_500, 80_000],
        );

        const ema = result.indicators.find(
            (indicator) => indicator.name === 'EMA 300',
        );

        expect(ema?.signal).toBe('LONG');
        expect(ema?.reason).toContain('3 закрытия подряд');
        expect(result.signal).toBe('LONG');
    });

    it('never uses more closes than the confirmation window asks for', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 10,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            // The oldest close is below the EMA, but it sits outside the window.
            [
                70_000,
                79_000,
                79_500,
                80_000,
                80_100,
                80_200,
            ],
        );

        const ema = result.indicators.find(
            (indicator) => indicator.name === 'EMA 300',
        );

        expect(ema?.signal).toBe('LONG');
    });

    it('weights the EMA vote by how far price sits from the average', () => {
        const near = calculateSignal(
            78_040,
            {
                ema300: 78_000,
                stochastic: 10,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(78_040, 3),
        );

        const far = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 10,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(80_000, 3),
        );

        const nearEma = near.indicators[0]?.weight ?? 0;
        const farEma = far.indicators[0]?.weight ?? 0;

        expect(nearEma).toBeGreaterThan(0);
        expect(nearEma).toBeLessThan(farEma);
    });

    it('abstains on momentum inside the deadband', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 50,
                momentum: 0.01,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(80_000, 3),
        );

        const momentum = result.indicators.find(
            (indicator) =>
                indicator.name === 'Momentum 100',
        );

        expect(momentum?.signal).toBe('NEUTRAL');
        expect(momentum?.weight).toBe(0);
        expect(momentum?.reason).toBe(
            `Momentum в нейтральной зоне ±${deadbandPercent}%`,
        );
    });

    it('votes once momentum clears the deadband', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 50,
                momentum: 0.5,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(80_000, 3),
        );

        const momentum = result.indicators.find(
            (indicator) =>
                indicator.name === 'Momentum 100',
        );

        expect(momentum?.signal).toBe('LONG');
        expect(momentum?.weight).toBeGreaterThan(0);
    });

    it('abstains on momentum at the deadband boundary', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 50,
                momentum: -deadbandPercent,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(80_000, 3),
        );

        expect(
            result.indicators[2]?.signal,
        ).toBe('NEUTRAL');
    });

    it('reports NEUTRAL when a single indicator is the only voice', () => {
        // Momentum alone, everything else neutral.
        const result = calculateSignal(
            80_000,
            {
                ema300: 80_000,
                stochastic: 50,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(80_000, 3),
        );

        expect(result.signal).toBe('NEUTRAL');
        expect(result.confidence).toBe(0);
        expect(result.reason).toBe(
            'Нет большинства: только Momentum 100 за LONG',
        );
    });

    it('abstains when the EMA is unusable rather than dividing by zero', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 0,
                stochastic: 50,
                momentum: 0,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
        );

        const ema = result.indicators[0];

        expect(ema?.signal).toBe('NEUTRAL');
        expect(ema?.weight).toBe(0);
        expect(Number.isFinite(ema?.weight ?? Number.NaN)).toBe(true);
        expect(result.signal).toBe('NEUTRAL');
    });

    it('never reports more than three votes', () => {
        const result = calculateSignal(
            80_000,
            {
                ema300: 78_000,
                stochastic: 10,
                momentum: 2,
                atr: 0.015,
                rsi: 52.5,
                macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
            },
            closesAbove(80_000, 3),
        );

        expect(result.indicators).toHaveLength(3);
        expect(confirmBars).toBe(3);
        expect(result.signal).toBe('LONG');
        // 98, not 99: the stochastic at 10 and the momentum at +2% clear
        // their thresholds convincingly but not perfectly, and the bound
        // charges them for it.
        expect(result.confidence).toBe(98);
        expect(result.reason).toBe(
            'EMA 300, Стохастик и Momentum 100 подтверждают LONG',
        );
    });
});
