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
    /** How long the worst dip lasted, in bars. A drawdown you cannot time is half a number. */
    maxDrawdownBars: number;
    /** Annualised from per-bar returns of the equity curve; 0 when there is no variance. */
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
     * declined to take the trades it would have lost. It counts signals, not
     * trades, so it can exceed `trades` — that gap is the abstention.
     */
    signalMix: { long: number; short: number; neutral: number };
}

/** A rule held to the same bars as the strategy, to say whether it earned anything. */
export interface BenchmarkMetrics {
    label: string;
    trades: number;
    totalReturn: number;
    maxDrawdown: number;
    sharpeRatio: number;
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
    maxDrawdownBars: 0,
    sharpeRatio: 0,
    averageWin: 0,
    averageLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    signalMix: { long: 0, short: 0, neutral: 0 },
};

/**
 * Worst peak-to-trough fall on the equity curve, and how long it lasted.
 *
 * Measured bar by bar rather than at trade closes. A position that goes −20%
 * mid-hold and closes at +1% is a drawdown an account would have felt and a
 * curve that only steps at closes cannot see; the flat stretches between
 * positions are where the account sat still and still lost nothing.
 */
function drawdown(equity: readonly number[]): {
    depth: number;
    bars: number;
} {
    let peak = equity[0] ?? 1;
    let worst = 0;
    let worstBars = 0;
    let troughIndex = 0;
    let peakIndex = 0;

    for (let index = 0; index < equity.length; index += 1) {
        const value = equity[index]!;

        if (value > peak) {
            peak = value;
            peakIndex = index;
            troughIndex = index;
        }

        const fall = peak === 0 ? 0 : (peak - value) / peak;

        if (fall > worst) {
            worst = fall;
            troughIndex = index;
        }

        worstBars = Math.max(worstBars, troughIndex - peakIndex);
    }

    return { depth: worst, bars: worstBars };
}

/**
 * Sharpe over per-bar returns of the equity curve.
 *
 * The observations are bars, which is what `samplesPerYear` counts, so the
 * annualisation is the right one: scaling trade returns by the number of bars
 * in a year reports a ratio several times larger than the same strategy's
 * per-bar volatility supports.
 *
 * No risk-free rate is subtracted — none is modelled anywhere in this layer,
 * and subtracting an assumed one would be a number nobody can trace.
 */
function sharpeRatio(equity: readonly number[], samplesPerYear: number): number {
    if (equity.length < 3) {
        return 0;
    }

    const returns: number[] = [];

    for (let index = 1; index < equity.length; index += 1) {
        const previous = equity[index - 1]!;

        if (previous === 0) {
            continue;
        }

        returns.push(equity[index]! / previous - 1);
    }

    if (returns.length < 2) {
        return 0;
    }

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;

    const variance =
        returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (returns.length - 1);

    const deviation = Math.sqrt(variance);

    if (deviation === 0) {
        // Every bar returned exactly the same amount: a ratio against zero
        // deviation is not a number, it is a division by nothing.
        return 0;
    }

    return (mean / deviation) * Math.sqrt(samplesPerYear);
}

export function calculateMetrics(
    trades: Trade[],
    /**
     * Account value at the close of every evaluated bar, starting at 1.
     *
     * Supplied by the caller rather than reconstructed here: only the caller
     * knows the candles, and a curve rebuilt from closed trades is exactly the
     * thing that hides intra-position losses.
     */
    equity: readonly number[],
    signalMix: BacktestMetrics['signalMix'],
    samplesPerYear: number,
): BacktestMetrics {
    if (trades.length === 0) {
        return { ...EMPTY_METRICS, signalMix: { ...signalMix } };
    }

    const sampleBars = equity.length;
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

    const worst = drawdown(equity);

    return {
        trades: trades.length,
        // Held bars can run past the evaluated window, because the last
        // signal in a fold still gets its full holding period. Exposure is a
        // fraction of the window and cannot exceed it.
        exposure: sampleBars > 0 ? Math.min(1, heldBars.size / sampleBars) : 0,
        winRate: wins.length / returns.length,
        totalReturn: equity.length === 0 ? 0 : equity.at(-1)! - 1,
        averageTrade,
        // No losses means profit factor is genuinely undefined, not infinite.
        // Reporting a large finite number would imply a risk that never
        // materialised, which is exactly the kind of illusion a backtest
        // should not produce.
        profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
        expectancy: averageTrade,
        maxDrawdown: worst.depth,
        maxDrawdownBars: worst.bars,
        sharpeRatio: sharpeRatio(equity, samplesPerYear),
        averageWin: wins.length === 0 ? 0 : grossProfit / wins.length,
        averageLoss: losses.length === 0 ? 0 : grossLoss / losses.length,
        largestWin: wins.length === 0 ? 0 : Math.max(...wins),
        largestLoss: losses.length === 0 ? 0 : Math.min(...losses),
        signalMix: { ...signalMix },
    };
}

/** Formats the same shape for a rule that never reads a signal. */
export function benchmarkMetrics(
    label: string,
    trades: Trade[],
    equity: readonly number[],
    samplesPerYear: number,
): BenchmarkMetrics {
    const worst = drawdown(equity);

    return {
        label,
        trades: trades.length,
        totalReturn: equity.length === 0 ? 0 : equity.at(-1)! - 1,
        maxDrawdown: worst.depth,
        sharpeRatio: sharpeRatio(equity, samplesPerYear),
    };
}
