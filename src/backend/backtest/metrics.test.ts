import { describe, expect, it } from 'vitest';
import type { Trade } from './metrics.js';
import { calculateMetrics, EMPTY_METRICS } from './metrics.js';

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

/**
 * A flat account value, `length` bars long.
 *
 * The equity curve is the caller's to supply, which is the point of the change
 * that introduced it: a curve rebuilt here from closed trade returns is the
 * thing that cannot see a position falling while it is open. Most of these
 * tests are about the trade statistics and do not care what the account did
 * between trades, so a flat one isolates them.
 */
function flatEquity(length: number): number[] {
    return Array.from({ length }, () => 1);
}

/** The account value a caller would have had, given these bar-over-bar moves. */
function equityOf(returns: number[]): number[] {
    const curve: number[] = [];
    let equity = 1;

    for (const value of returns) {
        equity *= 1 + value;
        curve.push(equity);
    }

    return curve;
}

describe('calculateMetrics', () => {
    it('reports nothing at all for an empty sample', () => {
        const metrics = calculateMetrics([], [], MIX, BARS_PER_YEAR);

        expect(metrics.trades).toBe(0);
        expect(metrics.totalReturn).toBe(0);
        expect(metrics.profitFactor).toBeNull();
    });

    it('does not share state with the empty template', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.25, grossReturn: 0.28, direction: 1 })],
            flatEquity(5),
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

    it('reads the total return off the end of the equity curve', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.1 }), trade({ netReturn: 0.1 })],
            equityOf([0.1, 0.1]),
            MIX,
            BARS_PER_YEAR,
        );

        // The curve is what an account held, bar by bar. Reading the return
        // off the trades instead would silently disagree with it whenever a
        // position was open across bars it did not close on.
        expect(metrics.totalReturn).toBeCloseTo(1.1 * 1.1 - 1, 10);
    });

    it('counts a win as a positive net return after costs', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: -0.001, grossReturn: 0.01 })],
            flatEquity(10),
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
            flatEquity(10),
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.profitFactor).toBeCloseTo(4, 10);
    });

    it('leaves the profit factor undefined when there were no losses', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.02 }), trade({ netReturn: 0.03 })],
            flatEquity(10),
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
            equityOf([0.5, -0.5, -0.5]),
            MIX,
            BARS_PER_YEAR,
        );

        // Equity runs 1 → 1.5 → 0.75 → 0.375. Measured from the start the
        // loss would read as 62.5%; measured from the 1.5 peak it is 75%.
        expect(metrics.maxDrawdown).toBeCloseTo(0.75, 10);
    });

    it('measures a dip the account recovered from', () => {
        // A position that falls 20% and closes higher is money an account lost
        // and a curve that only steps at trade closes cannot see. This is the
        // whole reason the curve is passed in rather than rebuilt.
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.05 })],
            equityOf([0.05, -0.25, 0.05, 0.05]),
            MIX,
            BARS_PER_YEAR,
        );

        // The curve runs 1 → 1.05 → 0.7875 → …, so the fall is 25% measured
        // from the peak. A -25% bar is not a 20% dip: the drop is relative to
        // where the account stood, not to where it started.
        expect(metrics.maxDrawdown).toBeCloseTo(0.25, 10);
    });

    it('reports how long the worst dip lasted', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.05 })],
            equityOf([0.05, -0.25, -0.05, 0.05, 0.05]),
            MIX,
            BARS_PER_YEAR,
        );

        // A drawdown without a duration cannot be acted on: two strategies can
        // print the same depth and one recovers in a week and the other in a
        // quarter.
        expect(metrics.maxDrawdownBars).toBeGreaterThan(0);
    });

    it('reports zero drawdown for a curve that only ever rises', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.2 })],
            equityOf([0.1, 0.1]),
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.maxDrawdown).toBe(0);
        expect(metrics.maxDrawdownBars).toBe(0);
    });

    it('reports zero rather than infinity for a flat curve', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.01 }), trade({ netReturn: 0.01 })],
            flatEquity(10),
            MIX,
            BARS_PER_YEAR,
        );

        // Zero deviation makes the ratio a division by nothing, not a number.
        expect(metrics.sharpeRatio).toBe(0);
    });

    it('returns zero Sharpe for a curve too short to have a distribution', () => {
        const metrics = calculateMetrics(
            [trade({ netReturn: 0.01 })],
            equityOf([0.01]),
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.sharpeRatio).toBe(0);
    });

    it('scales Sharpe by the number of periods in a year', () => {
        const curve = equityOf([0.01, -0.005, 0.012, -0.002]);
        const trades = [trade(), trade(), trade(), trade()];

        const daily = calculateMetrics(trades, curve, MIX, 365);
        const yearly = calculateMetrics(trades, curve, MIX, 1);

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
            flatEquity(10),
            MIX,
            BARS_PER_YEAR,
        );

        // Six bars, not six plus two.
        expect(metrics.exposure).toBeCloseTo(0.6, 10);
    });

    it('never reports exposure above one', () => {
        const metrics = calculateMetrics(
            [trade({ entryIndex: 0, exitIndex: 20 })],
            flatEquity(10),
            MIX,
            BARS_PER_YEAR,
        );

        // Exit bars can fall outside the evaluated window; exposure is a
        // fraction of it and cannot exceed it.
        expect(metrics.exposure).toBeLessThanOrEqual(1);
    });

    it('reports zero exposure for an empty sample rather than dividing by zero', () => {
        expect(calculateMetrics([], [], MIX, BARS_PER_YEAR).exposure).toBe(0);
    });

    it('keeps the signal mix, including the bars it declined to trade', () => {
        const metrics = calculateMetrics(
            [trade()],
            flatEquity(10),
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
        const metrics = calculateMetrics([], [], mix, BARS_PER_YEAR);

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
            flatEquity(10),
            MIX,
            BARS_PER_YEAR,
        );

        expect(metrics.largestWin).toBeCloseTo(0.05, 10);
        expect(metrics.largestLoss).toBeCloseTo(-0.03, 10);
        expect(metrics.largestWin).toBeGreaterThan(0);
        expect(metrics.largestLoss).toBeLessThan(0);
    });
});
