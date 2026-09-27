import { runStrategy } from './strategies.js';

import type { Strategy } from './strategies.js';
import type { ExecutionConfig } from '../backtest/execution.js';
import type { Candle } from '../types/market.js';

/**
 * Walk-forward for a strategy that has no parameters to fit.
 *
 * The walk-forward in `backtest/walk-forward.ts` fits thresholds on a training
 * window and judges them on the next one, which is the right shape for the
 * consensus rule, which has a grid of thresholds to fit. These strategies have
 * fixed parameters, so there is nothing to fit — and pretending otherwise by
 * running a plain backtest cut into pieces and calling it validation would be
 * the same mistake in a new place.
 *
 * What is left once fitting is removed is the question that actually decides
 * whether a rule is real: **is it profitable in most of the windows, or only in
 * the ones we happened to look at?** A rule that makes money in three folds out
 * of ten has not been validated, it has been described. So the summary here is
 * not the total return — it is the share of folds that were profitable, and the
 * worst fold, and how far the per-fold results spread. A rule that wins big in
 * one window and loses in the rest is a rule whose number is a property of the
 * window.
 *
 * Each fold is evaluated with the bars that precede it supplied purely as warm
 * up, and only trades opened inside the fold are counted. A strategy given a
 * fold and no history reports nothing at all, which is not a conservative
 * result but an absent one.
 */

export interface StrategyFold {
    readonly fold: number;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly trades: number;
    readonly totalReturn: number;
    readonly maxDrawdown: number;
    readonly profitFactor: number | null;
    readonly sharpeRatio: number;
    readonly buyAndHold: number;
}

export interface WalkForwardVerdict {
    readonly folds: readonly StrategyFold[];
    /** Share of folds that made money. The number to read first. */
    readonly profitableShare: number;
    readonly worstFold: number;
    readonly bestFold: number;
    /**
     * Whether the rule is worth taking past shadow.
     *
     * **This bar does not work, and the way it does not work is measured.**
     * Run four hundred random long-only rules through this same walk-forward on
     * Binance BTCUSDT — 2096 daily bars, folds of 250, 40% exposure, the same
     * costs — and not one has a positive worst fold. The best reaches 75% of
     * folds profitable, so the 60% share clause is nearly free and
     * `volatility-trend`'s 62.5% is inside what a coin gets. The clause
     * filtering everything is `worstFold > 0`, and no long-only rule paying
     * costs can clear it: fees plus non-zero exposure guarantee one losing
     * window by construction.
     *
     * So "nothing has ever passed walk-forward" in this project has been a
     * statement about commission arithmetic, not about any rule. `consistent`
     * is left as it is because changing the bar without a real replacement
     * would be worse — a clause that coins pass is not a pass condition. What
     * replaces it has to be a significance test against the same coins, which
     * `signal-power.ts` knows how to run.
     *
     * See `threshold-null.ts`, which is where the number comes from and is
     * tested.
     */
    readonly consistent: boolean;
    readonly reason: string;
}

export interface StrategyWalkForwardOptions {
    readonly foldBars: number;
    readonly execution?: ExecutionConfig;
    readonly barsPerYear?: number;
    /** Minimum share of folds that must be profitable. */
    readonly minimumProfitableShare?: number;
}

const DEFAULT_MINIMUM_PROFITABLE_SHARE = 0.6;

export function walkForwardStrategy(
    strategy: Strategy,
    candles: readonly Candle[],
    options: StrategyWalkForwardOptions,
): WalkForwardVerdict {
    const { foldBars } = options;

    if (foldBars <= 0) {
        throw new Error('foldBars must be greater than 0');
    }

    const folds: StrategyFold[] = [];
    const warmup = Math.max(0, strategy.warmup);

    for (
        let start = warmup;
        start + foldBars <= candles.length;
        start += foldBars
    ) {
        const end = start + foldBars;
        // History is supplied so the rule can warm up, and nothing before the
        // fold is allowed to produce a trade inside it.
        const window = candles.slice(start - warmup, end);
        const run = runStrategy(strategy, window, {
            ...(options.execution === undefined
                ? {}
                : { execution: options.execution }),
            ...(options.barsPerYear === undefined
                ? {}
                : { barsPerYear: options.barsPerYear }),
        });

        const first = window[warmup]!;
        const last = window[window.length - 1]!;

        folds.push({
            fold: folds.length,
            startIndex: start,
            endIndex: end,
            trades: run.metrics.trades,
            totalReturn: run.metrics.totalReturn,
            maxDrawdown: run.metrics.maxDrawdown,
            profitFactor: run.metrics.profitFactor,
            sharpeRatio: run.metrics.sharpeRatio,
            buyAndHold: last.close / first.close - 1,
        });
    }

    const returns = folds.map((fold) => fold.totalReturn);
    const profitable = returns.filter((value) => value > 0).length;
    const share = folds.length === 0 ? 0 : profitable / folds.length;
    const worst = returns.length === 0 ? 0 : Math.min(...returns);
    const best = returns.length === 0 ? 0 : Math.max(...returns);
    const minimum = options.minimumProfitableShare ?? DEFAULT_MINIMUM_PROFITABLE_SHARE;

    const consistent =
        folds.length >= 4 && share >= minimum && worst > 0;

    return {
        folds,
        profitableShare: share,
        worstFold: worst,
        bestFold: best,
        consistent,
        reason: verdictReason(folds, share, worst, minimum),
    };
}

function verdictReason(
    folds: readonly StrategyFold[],
    share: number,
    worst: number,
    minimum: number,
): string {
    if (folds.length < 4) {
        return (
            `слишком мало складок (${folds.length}), чтобы судить: ` +
            'правило, выигрывающее в двух окнах из двух, ничем не отличается ' +
            'от заговорённого'
        );
    }

    if (share < minimum) {
        return (
            `прибыльных складок ${(share * 100).toFixed(0)}%, нужно ${(minimum * 100).toFixed(0)}%: ` +
            'правило зависит от окна, а не от рынка'
        );
    }

    if (worst <= 0) {
        return (
            `худшая складка ${(worst * 100).toFixed(2)}%: ` +
            'правило где-то теряет больше, чем выигрывает, и выигрыш приходится ' +
            'на одно окно'
        );
    }

    return (
        `${(share * 100).toFixed(0)}% складок прибыльны, худшая ${(worst * 100).toFixed(2)}%: ` +
        'проходит порог, но это разрешение собирать данные, а не разрешение торговать'
    );
}
