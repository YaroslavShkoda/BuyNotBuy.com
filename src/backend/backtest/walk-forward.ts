import { calculateMetrics } from './metrics.js';
import { computeSignalSeries, reapplyThresholds } from './point-in-time.js';

import {
    INDICATOR_SIGNAL_CONFIG,
    STOCHASTIC_THRESHOLD_GRID,
    requiredCandleCount,
} from '../config/indicator.config.js';

import type { Candle } from '../types/market.js';
import type { BacktestMetrics, Trade } from './metrics.js';
import type { IndicatorSignalOverrides } from '../config/indicator.config.js';

export interface WalkForwardOptions {
    /**
     * Bars a position is held before it is closed. Matching the analysis
     * interval is what makes the result comparable with what the dashboard
     * actually recommends.
     */
    holdBars: number;
    /** Taker fee per side, as a fraction: 0.001 is 0.1%. */
    feeRate: number;
    /** Slippage per side, as a fraction. */
    slippageRate: number;
    /** Length of each evaluation window. */
    foldBars: number;
    /** Length of the window that precedes it and is used for fitting. */
    trainingBars: number;
    /** Evaluated windows to keep, newest first. */
    maxFolds: number;
    /**
     * Whether each fold's thresholds are chosen on its own training window.
     *
     * With this off the run is a plain backtest cut into windows, which is
     * still useful for seeing whether behaviour drifts but says nothing about
     * parameter stability. It is off only for the baseline comparison.
     */
    fitParameters: boolean;
    /** Bars per year, used to put the Sharpe ratio on a comparable scale. */
    barsPerYear: number;
}

export interface WalkForwardFold {
    fold: number;
    startIndex: number;
    endIndex: number;
    /** Thresholds this fold traded with, fitted or the shipped ones. */
    parameters: { longThreshold: number; shortThreshold: number };
    /** True when the fitted pair differs from the shipped configuration. */
    fitted: boolean;
    metrics: BacktestMetrics;
}

export interface WalkForwardResult {
    folds: WalkForwardFold[];
    trades: Trade[];
    /** Metrics across every fold combined — the number worth quoting. */
    overall: BacktestMetrics;
    /** The shipped configuration, run over the same folds for comparison. */
    baseline: BacktestMetrics;
    evaluatedBars: number;
    /** Fold count skipped because the sample was too short to evaluate them. */
    skippedFolds: number;
}

export const DEFAULT_WALK_FORWARD_OPTIONS: WalkForwardOptions = {
    holdBars: 1,
    // Binance taker fee is 0.1% per side, so a round trip costs 0.2% before
    // slippage. Leaving it out would flatter every metric here.
    feeRate: 0.001,
    slippageRate: 0.0005,
    foldBars: 120,
    trainingBars: 240,
    maxFolds: 10,
    fitParameters: true,
    barsPerYear: 365 * 24,
};

function roundTripCost(options: WalkForwardOptions): number {
    return 2 * (options.feeRate + options.slippageRate);
}

type SignalMix = { long: number; short: number; neutral: number };

interface SimulatedRange {
    trades: Trade[];
    mix: SignalMix;
}

function toOverrides(
    thresholds: { longThreshold: number; shortThreshold: number },
): IndicatorSignalOverrides {
    return { stochastic: thresholds };
}

/**
 * Turns signals into trades over `[startIndex, endIndex]`.
 *
 * The signal at bar `i` is built from closes up to and including `i`, so the
 * earliest honest entry is the open of bar `i + 1`. Entering at bar `i`'s own
 * close would trade on a price that only becomes known once that bar has
 * finished — a one-bar head start, repeated on every single trade.
 */
function simulateRange(
    candles: Candle[],
    points: ReadonlyArray<{
        index: number;
        signal: { signal: string };
    }>,
    startIndex: number,
    endIndex: number,
    options: WalkForwardOptions,
): SimulatedRange {
    const trades: Trade[] = [];
    const mix: SignalMix = { long: 0, short: 0, neutral: 0 };
    const cost = roundTripCost(options);

    for (const point of points) {
        const { index } = point;

        if (index < startIndex || index > endIndex) {
            continue;
        }

        const direction: 1 | -1 | null =
            point.signal.signal === 'LONG'
                ? 1
                : point.signal.signal === 'SHORT'
                    ? -1
                    : null;

        if (direction === 1) {
            mix.long += 1;
        } else if (direction === -1) {
            mix.short += 1;
        } else {
            mix.neutral += 1;
        }

        if (direction === null) {
            continue;
        }

        const entryCandle = candles[index + 1];
        const exitCandle = candles[index + 1 + options.holdBars];

        if (entryCandle === undefined || exitCandle === undefined) {
            continue;
        }

        const entryPrice = entryCandle.open;
        const exitPrice = exitCandle.close;
        const grossReturn = direction * (exitPrice / entryPrice - 1);

        trades.push({
            entryIndex: index + 1,
            exitIndex: index + 1 + options.holdBars,
            direction,
            entryPrice,
            exitPrice,
            netReturn: grossReturn - cost,
            grossReturn,
        });
    }

    return { trades, mix };
}

function addMix(target: SignalMix, source: SignalMix): void {
    target.long += source.long;
    target.short += source.short;
    target.neutral += source.neutral;
}

/**
 * Picks the threshold pair with the best expectancy on the training window.
 *
 * Expectancy rather than total return on purpose: a pair that wins once on a
 * 300% move and loses thirty times at -1% has a much larger total return and a
 * much worse expectation, and only one of those is a property of the rule.
 */
function fitThresholds(
    candles: Candle[],
    trainingStart: number,
    trainingEnd: number,
    options: WalkForwardOptions,
): { thresholds: { longThreshold: number; shortThreshold: number }; trainedTrades: number } {
    const points = computeSignalSeries(candles, trainingStart, trainingEnd);

    let best = STOCHASTIC_THRESHOLD_GRID[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of STOCHASTIC_THRESHOLD_GRID) {
        const fitted = reapplyThresholds(points, toOverrides(candidate));
        const { trades } = simulateRange(
            candles,
            fitted,
            trainingStart,
            trainingEnd,
            options,
        );

        if (trades.length === 0) {
            // A pair that never trades has no expectancy to rank, and treating
            // that as zero would let a dead configuration beat a live one.
            continue;
        }

        const expectancy =
            trades.reduce((sum, trade) => sum + trade.netReturn, 0) /
            trades.length;

        if (expectancy > bestScore) {
            bestScore = expectancy;
            best = candidate;
        }
    }

    if (bestScore === Number.NEGATIVE_INFINITY) {
        // Nothing traded anywhere in training. Keeping the shipped
        // configuration is the honest fallback: the fold then reports what
        // the product does, not a pair chosen by a coin flip.
        return {
            thresholds: {
                longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            },
            trainedTrades: 0,
        };
    }

    return { thresholds: best, trainedTrades: points.length };
}

function isShippedPair(thresholds: {
    longThreshold: number;
    shortThreshold: number;
}): boolean {
    return (
        thresholds.longThreshold ===
            INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold &&
        thresholds.shortThreshold ===
            INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold
    );
}

export function runWalkForward(
    candles: Candle[],
    options: Partial<WalkForwardOptions> = {},
): WalkForwardResult {
    const resolved = { ...DEFAULT_WALK_FORWARD_OPTIONS, ...options };

    // Indicators need a warm-up before the first bar they can be judged on;
    // a signal taken during warm-up is a half-formed EMA being scored.
    const warmup = requiredCandleCount();

    const step = resolved.foldBars;
    const needed = warmup + resolved.trainingBars + step;

    if (candles.length < needed) {
        return emptyResult(resolved);
    }

    const available = candles.length - warmup - resolved.trainingBars;
    const possibleFolds = Math.floor(available / step);
    const foldCount = Math.min(possibleFolds, resolved.maxFolds);

    // Folds are taken from the most recent data and worked backwards, so a
    // longer sample reports the folds that describe current behaviour rather
    // than the ones the market has since moved away from.
    const folds: WalkForwardFold[] = [];
    const allTrades: Trade[] = [];
    const baselineTrades: Trade[] = [];
    const mix: SignalMix = { long: 0, short: 0, neutral: 0 };
    let evaluatedBars = 0;

    for (let offset = 0; offset < foldCount; offset += 1) {
        const foldEnd = candles.length - 1 - offset * step;
        const foldStart = foldEnd - step + 1;
        const trainingEnd = foldStart - 1;
        const trainingStart = Math.max(warmup, trainingEnd - resolved.trainingBars + 1);

        if (foldStart < warmup || trainingEnd < trainingStart) {
            break;
        }

        const testPoints = computeSignalSeries(candles, foldStart, foldEnd);

        const fitted = resolved.fitParameters
            ? fitThresholds(candles, trainingStart, trainingEnd, resolved)
            : {
                  thresholds: {
                      longThreshold:
                          INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
                      shortThreshold:
                          INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
                  },
                  trainedTrades: 0,
              };

        const foldPoints = reapplyThresholds(
            testPoints,
            toOverrides(fitted.thresholds),
        );

        const result = simulateRange(
            candles,
            foldPoints,
            foldStart,
            foldEnd,
            resolved,
        );

        const baseline = simulateRange(
            candles,
            testPoints,
            foldStart,
            foldEnd,
            resolved,
        );

        addMix(mix, result.mix);
        evaluatedBars += step;
        allTrades.push(...result.trades);
        baselineTrades.push(...baseline.trades);

        folds.push({
            fold: foldCount - offset,
            startIndex: foldStart,
            endIndex: foldEnd,
            parameters: fitted.thresholds,
            fitted: !isShippedPair(fitted.thresholds),
            metrics: calculateMetrics(
                result.trades,
                step,
                result.mix,
                resolved.barsPerYear,
            ),
        });
    }

    return {
        // Oldest fold first: a reader compares the ends of the list.
        folds: folds.reverse(),
        trades: allTrades,
        overall: calculateMetrics(allTrades, evaluatedBars, mix, resolved.barsPerYear),
        baseline: calculateMetrics(
            baselineTrades,
            evaluatedBars,
            mix,
            resolved.barsPerYear,
        ),
        evaluatedBars,
        skippedFolds: Math.max(0, possibleFolds - foldCount),
    };
}

function emptyResult(options: WalkForwardOptions): WalkForwardResult {
    const empty = calculateMetrics(
        [],
        0,
        { long: 0, short: 0, neutral: 0 },
        options.barsPerYear,
    );

    return {
        folds: [],
        trades: [],
        overall: empty,
        baseline: empty,
        evaluatedBars: 0,
        skippedFolds: 0,
    };
}
