export interface Trade {
    /** Index of the candle the position was opened on. */
    entryIndex: number;
    /** Index of the candle the position was closed on. */
    exitIndex: number;
    direction: 1 | -1;
    entryPrice: number;
    exitPrice: number;
    /** Return after costs, as a fraction: 0.01 means +1%. */
    netReturn: number;
    /** Return before costs, for comparison. */
    grossReturn: number;
}

export interface BacktestMetrics {
    trades: number;
    /** Bars on which the strategy held a position, as a fraction of the sample. */
    exposure: number;
    winRate: number;
    totalReturn: number;
    averageTrade: number;
    profitFactor: number | null;
    expectancy: number;
    maxDrawdown: number;
    /** Annualised from per-bar trade returns; 0 when there is no variance. */
    sharpeRatio: number;
    averageWin: number;
    averageLoss: number;
    largestWin: number;
    largestLoss: number;
    /**
     * Signals per bar across the whole sample, including NEUTRAL ones.
     *
     * Without it a high hit rate is unreadable: a strategy that only speaks
     * when it is certain will show a flattering hit rate precisely because it
     * declined to take the trades it would have lost.
     */
    signalMix: { long: number; short: number; neutral: number };
}

export const EMPTY_METRICS: BacktestMetrics = {
    trades: 0,
    exposure: 0,
    winRate: 0,
    totalReturn: 0,
    averageTrade: 0,
    profitFactor: null,
    expectancy: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    averageWin: 0,
    averageLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    signalMix: { long: 0, short: 0, neutral: 0 },
};

/**
 * Compounded equity curve, step by step.
 *
 * Compounding rather than summing is the honest choice: it is the only way the
 * number matches what an account holding the position would have experienced.
 */
function equityCurve(returns: number[]): number[] {
    const curve: number[] = [];
    let equity = 1;

    for (const value of returns) {
        equity *= 1 + value;
        curve.push(equity);
    }

    return curve;
}

function maxDrawdown(returns: number[]): number {
    const curve = equityCurve(returns);

    let peak = 1;
    let worst = 0;

    for (const equity of curve) {
        peak = Math.max(peak, equity);

        const drawdown = (peak - equity) / peak;

        if (drawdown > worst) {
            worst = drawdown;
        }
    }

    return worst;
}

/**
 * Sharpe over per-bar trade returns.
 *
 * Reported with the usual caveats made explicit: a handful of trades is not a
 * distribution, and a ratio computed from two data points is noise with a
 * decimal point. `samplesPerYear` converts the scale to a figure that can be
 * compared with published ones, at the cost of assuming trades are evenly
 * spread through the year.
 */
function sharpeRatio(returns: number[], samplesPerYear: number): number {
    if (returns.length < 2) {
        return 0;
    }

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;

    const variance =
        returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (returns.length - 1);

    const deviation = Math.sqrt(variance);

    if (deviation === 0) {
        // Every trade returned exactly the same amount: a ratio against zero
        // deviation is not a number, it is a division by nothing.
        return 0;
    }

    return (mean / deviation) * Math.sqrt(samplesPerYear);
}

export function calculateMetrics(
    trades: Trade[],
    sampleBars: number,
    signalMix: BacktestMetrics['signalMix'],
    samplesPerYear: number,
): BacktestMetrics {
    if (trades.length === 0) {
        return { ...EMPTY_METRICS, signalMix: { ...signalMix } };
    }

    const returns = trades.map((trade) => trade.netReturn);
    const wins = returns.filter((value) => value > 0);
    const losses = returns.filter((value) => value < 0);

    const grossProfit = wins.reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));

    const averageTrade = returns.reduce((sum, value) => sum + value, 0) / returns.length;

    // Held bars, counting each bar once even if two positions overlapped.
    const heldBars = new Set<number>();

    for (const trade of trades) {
        for (let index = trade.entryIndex; index <= trade.exitIndex; index += 1) {
            heldBars.add(index);
        }
    }

    return {
        trades: trades.length,
        // Held bars can run past the evaluated window, because the last
        // signal in a fold still gets its full holding period. Exposure is a
        // fraction of the window and cannot exceed it.
        exposure:
            sampleBars > 0 ? Math.min(1, heldBars.size / sampleBars) : 0,
        winRate: wins.length / returns.length,
        totalReturn: equityCurve(returns).at(-1)! - 1,
        averageTrade,
        // No losses means profit factor is genuinely undefined, not infinite.
        // Reporting a large finite number would imply a risk that never
        // materialised, which is exactly the kind of illusion a backtest
        // should not produce.
        profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
        expectancy: averageTrade,
        maxDrawdown: maxDrawdown(returns),
        sharpeRatio: sharpeRatio(returns, samplesPerYear),
        averageWin: wins.length === 0 ? 0 : grossProfit / wins.length,
        averageLoss: losses.length === 0 ? 0 : grossLoss / losses.length,
        largestWin: wins.length === 0 ? 0 : Math.max(...wins),
        largestLoss: losses.length === 0 ? 0 : Math.min(...losses),
        signalMix: { ...signalMix },
    };
}
