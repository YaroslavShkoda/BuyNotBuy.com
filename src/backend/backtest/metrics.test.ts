import { describe, expect, it } from 'vitest';

import { calculateMetrics, EMPTY_METRICS } from './metrics.js';

import type { Trade } from './metrics.js';

const MIX = { long: 0, short: 0, neutral: 0 };
const BARS_PER_YEAR = 365 * 24;

function trade(overrides: Partial<Trade> = {}): Trade {
    return {
        entryIndex: 0,
        exitIndex: 1,
        direction: 1,
        entryPrice: 100,
        exitPrice: 101,
        netReturn: 0.01,
        grossReturn: 0.01,
        ...overrides,
    };
}

describe('calculateMetrics', () => {
    it('reports nothing at all for an empty sample', () => {
        const metrics = calculateMetrics([], 0, MIX, BARS_PER_YEAR);

        expect(metrics.trades).toBe(0);
        expect(metrics.totalReturn).toBe(0);
        expect(metrics.profitFactor).toBeNull();
    });

    it('does not share state with the empty template', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.25, grossReturn: 0.28, direction: 1 })],
            5,
            { long: 1, short: 0, neutral: 0 },
            BARS_PER_YEAR,
        );

        // Every empty report starts life as this one object. A caller that
        // mutates a result it received must not thereby change what the next
        // empty report looks like, so the template is a copy, not an alias.
        metrics.signalMix.long = 99;
        metrics.totalReturn = 99;

        expect(EMPTY_METRICS.signalMix.long).toBe(0);
        expect(EMPTY_METRICS.totalReturn).toBe(0);
    });

    it('compounds the returns instead of adding them', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.1 }), trade({ netReturn: 0.1 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.totalReturn).toBeCloseTo(1.1 * 1.1 - 1, 10);
    });

    it('counts a win as a positive net return after costs', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: -0.001, grossReturn: 0.01 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        // A trade that was profitable before costs and not after it is a
        // loss, and the report has to say so.
        expect(metrics.winRate).toBe(0);
    });

    it('computes the profit factor from net returns', () => {
        const metrics = calculateMetrics(
            [
                trade({ netReturn: 0.02 }),
                trade({ netReturn: 0.02 }),
                trade({ netReturn: -0.01 }),
            ],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.profitFactor).toBeCloseTo(4, 10);
    });

    it('leaves the profit factor undefined when there were no losses', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.02 }), trade({ netReturn: 0.03 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        // A number here would imply a risk that never materialised, which is
        // exactly the kind of illusion a backtest must not produce.
        expect(metrics.profitFactor).toBeNull();
        expect(metrics.averageLoss).toBe(0);
    });

    it('measures the drawdown from the equity peak, not from the start', () => {
        const metrics = calculateMetrics(
            [
                trade({ netReturn: 0.5 }),
                trade({ netReturn: -0.5 }),
                trade({ netReturn: -0.5 }),
            ],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        // Equity runs 1 → 1.5 → 0.75 → 0.375. Measured from the start the
        // loss would read as 62.5%; measured from the 1.5 peak it is 75%.
        expect(metrics.maxDrawdown).toBeCloseTo(0.75, 10);
    });

    it('ignores an unrealised gain when measuring the drawdown', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.2 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.maxDrawdown).toBe(0);
    });

    it('reports zero rather than infinity for a flat series', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.01 }), trade({ netReturn: 0.01 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        // Zero deviation makes the ratio a division by nothing, not a number.
        expect(metrics.sharpeRatio).toBe(0);
    });

    it('returns zero Sharpe for a single trade', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.01 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.sharpeRatio).toBe(0);
    });

    it('scales Sharpe by the number of periods in a year', () => {
        const trades = [
            trade({ netReturn: 0.01 }),
            trade({ netReturn: -0.005 }),
            trade({ netReturn: 0.012 }),
            trade({ netReturn: -0.002 }),
        ];

        const daily = calculateMetrics(trades, 100, MIX, 365);
        const yearly = calculateMetrics(trades, 100, MIX, 1);

        expect(Math.abs(daily.sharpeRatio)).toBeGreaterThan(
            Math.abs(yearly.sharpeRatio),
        );
    });

    it('counts a bar as held once even when positions overlap', () => {
        const metrics = calculateMetrics(
            [
                trade({ entryIndex: 0, exitIndex: 5 }),
                trade({ entryIndex: 2, exitIndex: 3 }),
            ],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        // Six bars, not six plus two.
        expect(metrics.exposure).toBeCloseTo(0.6, 10);
    });

    it('never reports exposure above one', () => {
        const metrics = calculateMetrics(
            [trade({ entryIndex: 0, exitIndex: 20 })],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        // Exit bars can fall outside the evaluated window; exposure is a
        // fraction of it and cannot exceed it.
        expect(metrics.exposure).toBeLessThanOrEqual(1);
    });

    it('reports zero exposure for an empty sample rather than dividing by zero', () => {
        expect(calculateMetrics([], 0, MIX, BARS_PER_YEAR).exposure).toBe(0);
    });

    it('keeps the signal mix, including the bars it declined to trade', () => {
        const metrics = calculateMetrics(
            [trade()],
            10,
            { long: 4, short: 1, neutral: 5 },
            BARS_PER_YEAR,
        );

        // Without the abstentions a hit rate is unreadable: a strategy that
        // only speaks when it is certain shows a flattering number precisely
        // because it declined the trades it would have lost.
        expect(metrics.signalMix).toEqual({ long: 4, short: 1, neutral: 5 });
    });

    it('copies the signal mix instead of aliasing it', () => {
        const mix = { long: 1, short: 1, neutral: 1 };
        const metrics = calculateMetrics([], 0, mix, BARS_PER_YEAR);

        mix.long = 99;

        expect(metrics.signalMix.long).toBe(1);
    });

    it('separates the largest win from the largest loss', () => {
        const metrics = calculateMetrics(
            [
                trade({ netReturn: 0.02 }),
                trade({ netReturn: -0.03 }),
                trade({ netReturn: 0.05 }),
            ],
            10,
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.largestWin).toBeCloseTo(0.05, 10);
        expect(metrics.largestLoss).toBeCloseTo(-0.03, 10);
        expect(metrics.largestWin).toBeGreaterThan(0);
        expect(metrics.largestLoss).toBeLessThan(0);
    });
});
