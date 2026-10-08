import type {
    ResolvedIndicatorSignalConfig,
} from '../config/indicator.config.js';
import {
    INDICATOR_SIGNAL_CONFIG,
    requiredCandleCount,
    STOCHASTIC_THRESHOLD_GRID,
} from '../config/indicator.config.js';
import type { IndicatorSignalOverrides } from '../config/strategy.profile.js';
import type { Candle } from '../types/market.js';
import type { ExecutionConfig } from './execution.js';
import { EXECUTION_CONFIG, fillPrice, roundTripCost } from './execution.js';
import type { BacktestMetrics, BenchmarkMetrics, Trade } from './metrics.js';
import { benchmarkMetrics, calculateMetrics } from './metrics.js';
import { computeSignalSeries, reapplyThresholds } from './point-in-time.js';
import type { FoldPlan, PlanShape, Window } from './walk-forward.plan.js';
import { DEFAULT_VALIDATION_RATIO, judgeFold } from './walk-forward.plan.js';

export interface WalkForwardOptions extends PlanShape {
    /**
     * Bars a position is held before it is closed. Matching the analysis
     * interval is what makes the result comparable with what the dashboard
     * actually recommends.
     */
    holdBars: number;
    /**
     * Costs and fill assumptions.
     *
     * A single object rather than three scalars because a rate on its own is
     * not a cost model: `feeRate` and `slippageRate` are still here, they are
     * simply the one-figure shorthand for the default `ExecutionConfig`, and
     * a backtest that reports them without saying which fill it assumed has
     * quietly answered a question nobody asked it.
     */
    execution: ExecutionConfig;
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

interface WalkForwardFold {
    fold: number;
    startIndex: number;
    endIndex: number;
    /**
     * The three windows this fold actually ran on, as `auditWalkForwardPlan`
     * sees them.
     *
     * On the result rather than inside the loop because "the windows were
     * disjoint" is a claim about the run, and a claim about the run that the
     * run does not report can only be taken on trust. Carrying the plan out
     * also lets the leakage audit run over output a caller already has, rather
     * than over a plan rebuilt from the same arithmetic that produced the bug.
     */
    windows: FoldPlan;
    /** Thresholds this fold traded with, fitted or the shipped ones. */
    parameters: { longThreshold: number; shortThreshold: number };
    /** True when the fitted pair differs from the shipped configuration. */
    fitted: boolean;
    /**
     * Whether the fitted pair survived being checked on the bars immediately
     * after the ones it was chosen on.
     *
     * Reported whether it passed or not. Dropping the failed folds would
     * remove the worst ones from the average, and the average would then
     * describe a strategy nobody trades; keeping them unlabelled would hide
     * that they were ever in doubt.
     */
    validation: {
        accepted: boolean;
        reason: string;
        trainingScore: number | null;
        validationScore: number | null;
    };
    metrics: BacktestMetrics;
}

export interface WalkForwardResult {
    folds: WalkForwardFold[];
    trades: Trade[];
    /** Metrics across every fold combined — the number worth quoting. */
    overall: BacktestMetrics;
    /** The shipped configuration, run over the same folds for comparison. */
    baseline: BacktestMetrics;
    /**
     * Rules held to the same bars, paying the same costs.
     *
     * A backtest with nothing to compare against answers a question nobody
     * asked: whether the strategy made money, rather than whether it would
     * have been better to do the obvious thing. `randomEntry` is the sharper
     * of the two — the same number of trades, the same holding period, the
     * same price path, and no information at all. A strategy that cannot beat
     * it is reading noise.
     */
    benchmarks: {
        buyAndHold: BenchmarkMetrics;
        randomEntry: BenchmarkMetrics;
    };
    /**
     * Strategy total return minus buy-and-hold over the same bars, or null
     * when there was nothing to evaluate.
     *
     * Null rather than zero: a run that produced no trades has not matched
     * the benchmark, it has failed to produce a number.
     */
    excessOverBuyAndHold: number | null;
    evaluatedBars: number;
    /** Fold count skipped because the sample was too short to evaluate them. */
    skippedFolds: number;
}

export const DEFAULT_WALK_FORWARD_OPTIONS: WalkForwardOptions = {
    holdBars: 1,
    // The pessimistic fill and the full taker fee, both of which are the point
    // of living in `execution.ts`. A backtest that assumed a maker discount it
    // did not get, or that assumed the good intrabar order, would report a
    // strategy that does not work as one that does.
    execution: EXECUTION_CONFIG,
    foldBars: 120,
    trainingBars: 240,
    maxFolds: 10,
    fitParameters: true,
    barsPerYear: 365 * 24,
};

function roundTripCostFor(options: WalkForwardOptions): number {
    return roundTripCost(options.execution);
}

type SignalMix = { long: number; short: number; neutral: number };

interface SimulatedRange {
    trades: Trade[];
    mix: SignalMix;
    /** Account value at every bar close across the evaluated window. */
    equity: number[];
}

function toOverrides(
    thresholds: { longThreshold: number; shortThreshold: number },
): IndicatorSignalOverrides {
    return { stochastic: thresholds };
}

/**
 * Account value at the close of every bar in `[startBar, endBar]`.
 *
 * Marked to market, not stepped at trade closes. A position that falls 20%
 * mid-hold and closes higher is money an account lost and a curve that only
 * moves at closes cannot see — and a drawdown read off that curve is the
 * number a reader uses to size a position.
 *
 * `trades` must not overlap, which `simulateRange` guarantees by holding at
 * most one position at a time; with overlap there is no single account value
 * to report, which is the other reason overlap is not left in.
 */
function buildEquityCurve(
    candles: Candle[],
    trades: readonly Trade[],
    startBar: number,
    endBar: number,
    cost: number,
): number[] {
    const curve: number[] = [];
    let realised = 1;
    let cursor = 0;
    let open: Trade | null = null;

    for (let bar = startBar; bar <= endBar; bar += 1) {
        // Closing before opening keeps a trade that enters and exits on the
        // same bar counted once, realised, rather than marked and then closed.
        if (open !== null && bar === open.exitIndex) {
            realised *= 1 + open.netReturn;
            open = null;
        }

        if (cursor < trades.length && trades[cursor]!.entryIndex === bar) {
            open = trades[cursor]!;
            cursor += 1;
        }

        const candle = candles[bar];

        if (open === null || candle === undefined) {
            curve.push(realised);
            continue;
        }

        const unrealised =
            open.direction * (candle.close / open.entryPrice - 1) - cost;

        curve.push(realised * (1 + unrealised));
    }

    return curve;
}

/**
 * Turns signals into trades over `[startIndex, endIndex]`.
 *
 * The signal at bar `i` is built from closes up to and including `i`, so the
 * earliest honest entry is the open of bar `i + 1`. Entering at bar `i`'s own
 * close would trade on a price that only becomes known once that bar has
 * finished — a one-bar head start, repeated on every single trade.
 *
 * Two rules keep the result inside the window it claims:
 *
 * - A position is closed by `endIndex`. The last signal of a window used to
 *   exit `holdBars` bars *past* it, which for a training window means the
 *   threshold fit was scored partly on bars the fold then reported as
 *   out-of-sample, and for a test window means bars belonging to the next
 *   window's fitting data. Both are the one thing walk-forward is for.
 * - One position at a time. A signal arriving while a position is open is
 *   skipped rather than stacked, because stacking is leverage nobody sized
 *   and no account has.
 */
export function simulateRange(
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
    const cost = roundTripCostFor(options);
    const lastEntryIndex = endIndex - 1 - options.holdBars;

    // Bar at which the current position closes; -1 while flat.
    let flatFrom = startIndex;

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

        // Counted for every signal in the window, traded or not: the gap
        // between this and `trades` is the strategy declining to act.
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

        // Already holding a position: the signal is counted and not taken.
        if (index < flatFrom) {
            continue;
        }

        // Closing past the window would score this trade on bars that belong
        // to another window.
        if (index > lastEntryIndex) {
            continue;
        }

        const entryCandle = candles[index + 1];
        const exitCandle = candles[index + 1 + options.holdBars];

        if (entryCandle === undefined || exitCandle === undefined) {
            continue;
        }

        // Filled through the execution model rather than read off the bar.
        // Every price a trade is booked at is a price somebody has to be
        // assumed able to get, and the model is where that assumption is
        // written down. Reading `open` and `close` here would leave the module
        // defined, tested and unused, which is worse than not having it: the
        // report would name a fill it never applied.
        const entryPrice = fillPrice(
            entryCandle,
            direction,
            options.execution,
            true,
        );
        const exitPrice = fillPrice(
            exitCandle,
            direction,
            options.execution,
            false,
        );

        // Gross is the move with nothing paid for anything, kept beside the
        // net so a report can say what the costs took rather than only what
        // survived them. A strategy whose edge is smaller than its fees has a
        // positive gross and a negative net, and that pair is the finding.
        const grossReturn =
            direction * (exitCandle.close / entryCandle.open - 1);
        const netReturn = direction * (exitPrice / entryPrice - 1);

        trades.push({
            entryIndex: index + 1,
            exitIndex: index + 1 + options.holdBars,
            direction,
            entryPrice,
            exitPrice,
            netReturn,
            grossReturn,
        });

        flatFrom = index + 1 + options.holdBars;
    }

    return {
        trades,
        mix,
        equity: buildEquityCurve(candles, trades, startIndex, endIndex, cost),
    };
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
    signal: ResolvedIndicatorSignalConfig,
): {
    thresholds: { longThreshold: number; shortThreshold: number };
    trainedTrades: number;
    /**
     * The same pair's expectancy on a window it was not chosen on.
     *
     * Measured rather than assumed because "it did badly on validation" and "it
     * was never measured on validation" are different sentences, and a fold
     * report that cannot tell them apart will quietly claim the first.
     */
    trainingScore: number | null;
    validationScore: number | null;
    /**
     * The bars `validationScore` was actually measured on, or null when nothing
     * was fitted and therefore nothing was validated.
     *
     * Reported rather than reconstructed by the caller because the caller's job
     * is to run the fold, not to guess which slice of the training span the fit
     * was kept off. A caller that rebuilds this window is duplicating a split
     * that already happened, and a split that is duplicated is a split that can
     * disagree with itself — the plan would then describe windows the run never
     * used, which is the one thing the plan exists to prevent.
     */
    validation: Window | null;
} {
    const points = computeSignalSeries(candles, trainingStart, trainingEnd);

    // The tail of the training span, kept out of the fit and scored
    // separately. Taken from inside the span because those are the only bars
    // this fold was given; the bar after them belongs to the test window.
    const span = trainingEnd - trainingStart + 1;
    const validationLength = Math.max(
        1,
        Math.floor(span * DEFAULT_VALIDATION_RATIO),
    );
    const validationStart = trainingEnd - validationLength + 1;

    let best = STOCHASTIC_THRESHOLD_GRID[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of STOCHASTIC_THRESHOLD_GRID) {
        const fitted = reapplyThresholds(points, toOverrides(candidate));
        const { trades } = simulateRange(
            candles,
            fitted,
            trainingStart,
            validationStart - 1,
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
                longThreshold: signal.stochastic.longThreshold,
                shortThreshold: signal.stochastic.shortThreshold,
            },
            trainedTrades: 0,
            trainingScore: null,
            validationScore: null,
            // No pair was chosen, so no window was held back for scoring it.
            // Claiming one here is what makes a plan describe a validation
            // stage that never ran.
            validation: null,
        };
    }

    const validationPoints = computeSignalSeries(
        candles,
        validationStart,
        trainingEnd,
    );
    const validationTrades = simulateRange(
        candles,
        reapplyThresholds(validationPoints, toOverrides(best)),
        validationStart,
        trainingEnd,
        options,
    ).trades;

    return {
        thresholds: best,
        trainedTrades: points.length,
        trainingScore: bestScore,
        validationScore:
            validationTrades.length === 0
                ? null
                : validationTrades.reduce(
                      (sum, trade) => sum + trade.netReturn,
                      0,
                  ) / validationTrades.length,
        // The same `validationStart..trainingEnd` the score above was measured
        // on, carried out of the function that measured it.
        validation: { startIndex: validationStart, endIndex: trainingEnd },
    };
}

function isShippedPair(
    thresholds: {
        longThreshold: number;
        shortThreshold: number;
    },
    signal: ResolvedIndicatorSignalConfig,
): boolean {
    // Compared against the thresholds in force for the market this fold is
    // about, not against the global ones. With per-asset overrides the global
    // pair is not what the product ships anywhere else, so a fold that returned
    // to the configured pair would be reported as a fitted one — and the report
    // would say the strategy was tuned when nothing had been tuned at all.
    return (
        thresholds.longThreshold === signal.stochastic.longThreshold &&
        thresholds.shortThreshold === signal.stochastic.shortThreshold
    );
}

/** Deterministic PRNG. A benchmark that changes between runs is not a benchmark. */
function seededRandom(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

        return state / 0x1_0000_0000;
    };
}

/**
 * Buy at the first evaluated bar, hold to the last, pay the same round trip.
 *
 * Charged the same cost deliberately. A cost-inclusive strategy measured
 * against a cost-free benchmark is being flattered by exactly the amount it
 * pays in fees, and that amount is the whole trade.
 */
function buyAndHoldBenchmark(
    candles: Candle[],
    startBar: number,
    endBar: number,
    cost: number,
    samplesPerYear: number,
    execution: ExecutionConfig,
): BenchmarkMetrics {
    const entry = candles[startBar];
    const exit = candles[endBar];

    if (entry === undefined || exit === undefined) {
        return {
            label: 'Buy & hold',
            trades: 0,
            totalReturn: 0,
            maxDrawdown: 0,
            sharpeRatio: 0,
        };
    }

    const grossReturn = exit.close / entry.open - 1;

    // Priced through the same model as the strategy, or the benchmark is
    // holding to an assumption the strategy is not.
    const entryPrice = fillPrice(entry, 1, execution, true);
    const exitPrice = fillPrice(exit, 1, execution, false);
    const netReturn = exitPrice / entryPrice - 1;

    const trade: Trade = {
        entryIndex: startBar,
        exitIndex: endBar,
        direction: 1,
        entryPrice,
        exitPrice,
        netReturn,
        grossReturn,
    };

    return benchmarkMetrics(
        'Buy & hold',
        [trade],
        buildEquityCurve(candles, [trade], startBar, endBar, cost),
        samplesPerYear,
    );
}

/**
 * The same number of trades, the same holding period, the same price path, and
 * no information at all — averaged over many seeds.
 *
 * This is the benchmark that answers the only question a signal is worth
 * asking: does the timing carry anything, or does the strategy merely look
 * busy? A signal that cannot beat random entry over the same bars is
 * describing the market's noise with a confident voice.
 */
function randomEntryBenchmark(
    candles: Candle[],
    startBar: number,
    endBar: number,
    cost: number,
    tradeCount: number,
    holdBars: number,
    samplesPerYear: number,
    execution: ExecutionConfig,
): BenchmarkMetrics {
    const TRIALS = 200;
    const random = seededRandom(0x5eed);
    const lastEntry = endBar - 1 - holdBars;

    let totalReturn = 0;
    let maxDrawdown = 0;
    let sharpeSum = 0;
    let takenTotal = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
        const trades: Trade[] = [];
        let cursor = startBar;

        // A random tiling of the window, not a random draw repeated until one
        // happens to fit. Drawing from the free remainder — or from the whole
        // window and discarding the collisions — runs out of attempts long
        // before the trade count is reached, because the hit rate falls as the
        // window fills. Every entry is placed uniformly among the positions
        // that still leave room for the trades not yet taken, so the count
        // being compared is the count actually taken.
        while (trades.length < tradeCount) {
            const stillNeeded = tradeCount - trades.length;
            const latest = lastEntry - (stillNeeded - 1) * (holdBars + 1);

            if (latest < cursor) {
                break;
            }

            const index = cursor + Math.floor(random() * (latest - cursor + 1));
            const direction: 1 | -1 = random() < 0.5 ? 1 : -1;
            const entryCandle = candles[index + 1];
            const exitCandle = candles[index + 1 + holdBars];

            if (entryCandle === undefined || exitCandle === undefined) {
                break;
            }

            const grossReturn =
                direction * (exitCandle.close / entryCandle.open - 1);

            // The same fills the strategy got. A random benchmark paying a
            // different cost from the strategy it is meant to bound is not a
            // benchmark, it is a second opinion with a bias.
            const entryPrice = fillPrice(
                entryCandle,
                direction,
                execution,
                true,
            );
            const exitPrice = fillPrice(
                exitCandle,
                direction,
                execution,
                false,
            );
            const netReturn = direction * (exitPrice / entryPrice - 1);

            trades.push({
                entryIndex: index + 1,
                exitIndex: index + 1 + holdBars,
                direction,
                entryPrice,
                exitPrice,
                netReturn,
                grossReturn,
            });

            cursor = index + 1 + holdBars;
        }

        const sample = benchmarkMetrics(
            '',
            trades,
            buildEquityCurve(candles, trades, startBar, endBar, cost),
            samplesPerYear,
        );

        totalReturn += sample.totalReturn;
        maxDrawdown += sample.maxDrawdown;
        sharpeSum += sample.sharpeRatio;
        takenTotal += trades.length;
    }

    return {
        label: `Случайный вход (${tradeCount} сделок, среднее из ${TRIALS})`,
        trades: takenTotal / TRIALS,
        totalReturn: totalReturn / TRIALS,
        maxDrawdown: maxDrawdown / TRIALS,
        sharpeRatio: sharpeSum / TRIALS,
    };
}

export function runWalkForward(
    candles: Candle[],
    options: Partial<WalkForwardOptions> = {},
    /**
     * The thresholds in force for the market this run is about.
     *
     * Defaults to the shipped configuration so every existing caller keeps
     * working, exactly as `resolveRequest` does for the market itself. It is an
     * argument rather than a read because a fold that "returned to the shipped
     * pair" is a claim about a specific pair, and with per-asset overrides
     * there is no single shipped pair to return to.
     */
    signal: ResolvedIndicatorSignalConfig = INDICATOR_SIGNAL_CONFIG,
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
    // The baseline's own mix, not a second copy of the fitted one: the two
    // strategies signal on different bars, and reporting the fitted strategy's
    // counts under the baseline's name is a wrong number, not an approximation.
    const baselineMix: SignalMix = { long: 0, short: 0, neutral: 0 };
    let evaluatedBars = 0;
    let evaluatedStart = Number.POSITIVE_INFINITY;
    let evaluatedEnd = Number.NEGATIVE_INFINITY;

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
            ? fitThresholds(candles, trainingStart, trainingEnd, resolved, signal)
            : {
                  thresholds: {
                      longThreshold: signal.stochastic.longThreshold,
                      shortThreshold: signal.stochastic.shortThreshold,
                  },
                  trainedTrades: 0,
                  trainingScore: null,
                  validationScore: null,
                  // Nothing was fitted, so nothing was held back for scoring.
                  validation: null,
              };

        // The fit runs on the head of the training span and the pair is scored
        // on the tail, so those are two windows and not one window named twice.
        // `fitThresholds` is the only place that split is known; the plan reads
        // it rather than recomputing it, because a plan that re-derives its own
        // windows is a plan that can disagree with the run it describes.
        const validate = fitted.validation;
        const foldPlan: FoldPlan = {
            fold: foldCount - offset,
            train: {
                startIndex: trainingStart,
                endIndex: validate === null ? trainingEnd : validate.startIndex - 1,
            },
            // A fold that fitted nothing has no validation window to name. It
            // is reported as an empty window rather than as the training span,
            // so `auditWalkForwardPlan` calls it out instead of a plan quietly
            // claiming a validation stage that never ran.
            validate: validate ?? { startIndex: trainingEnd + 1, endIndex: trainingEnd },
            test: { startIndex: foldStart, endIndex: foldEnd },
        };

        const judgement = judgeFold(foldPlan, fitted.trainingScore, fitted.validationScore);

        // A rejected fold keeps the configured thresholds rather than the pair
        // that failed. "Configured" and not "the global ones" because for a
        // market with its own thresholds, those are the ones the product ships.
        // The rejected pair is still reported, and still measured on its test
        // window, because a fold that was in doubt and then traded anyway is a
        // fact about the strategy that is worth having.
        const thresholds = judgement.accepted
            ? fitted.thresholds
            : {
                  longThreshold: signal.stochastic.longThreshold,
                  shortThreshold: signal.stochastic.shortThreshold,
              };

        const foldPoints = reapplyThresholds(
            testPoints,
            toOverrides(thresholds),
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
        addMix(baselineMix, baseline.mix);
        evaluatedBars += step;
        evaluatedStart = Math.min(evaluatedStart, foldStart);
        evaluatedEnd = Math.max(evaluatedEnd, foldEnd);
        allTrades.push(...result.trades);
        baselineTrades.push(...baseline.trades);

        folds.push({
            fold: foldCount - offset,
            startIndex: foldStart,
            endIndex: foldEnd,
            // The pair actually traded with, which is the shipped one when
            // validation rejected the fit. Reporting the rejected pair here
            // would describe a strategy the run did not evaluate.
            parameters: thresholds,
            fitted:
                !isShippedPair(thresholds, signal) && judgement.accepted,
            windows: foldPlan,
            validation: {
                accepted: judgement.accepted,
                reason: judgement.reason,
                trainingScore: fitted.trainingScore,
                validationScore: fitted.validationScore,
            },
            metrics: calculateMetrics(
                result.trades,
                result.equity,
                result.mix,
                resolved.barsPerYear,
            ),
        });
    }

    if (evaluatedBars === 0) {
        return emptyResult(resolved);
    }

    // Folds are visited newest first, so the pooled trades arrive backwards.
    // The equity curve walks bars forwards and has to find them in order.
    allTrades.sort(byEntryIndex);
    baselineTrades.sort(byEntryIndex);

    const cost = roundTripCostFor(resolved);
    const overallEquity = buildEquityCurve(
        candles,
        allTrades,
        evaluatedStart,
        evaluatedEnd,
        cost,
    );
    const baselineEquity = buildEquityCurve(
        candles,
        baselineTrades,
        evaluatedStart,
        evaluatedEnd,
        cost,
    );

    const benchmarks = {
        buyAndHold: buyAndHoldBenchmark(
            candles,
            evaluatedStart,
            evaluatedEnd,
            cost,
            resolved.barsPerYear,
            resolved.execution,
        ),
        randomEntry: randomEntryBenchmark(
            candles,
            evaluatedStart,
            evaluatedEnd,
            cost,
            allTrades.length,
            resolved.holdBars,
            resolved.barsPerYear,
            resolved.execution,
        ),
    };

    const overall = calculateMetrics(
        allTrades,
        overallEquity,
        mix,
        resolved.barsPerYear,
    );

    return {
        // Oldest fold first: a reader compares the ends of the list.
        folds: folds.reverse(),
        trades: allTrades,
        overall,
        baseline: calculateMetrics(
            baselineTrades,
            baselineEquity,
            baselineMix,
            resolved.barsPerYear,
        ),
        benchmarks,
        excessOverBuyAndHold: allTrades.length === 0
            ? null
            : overall.totalReturn - benchmarks.buyAndHold.totalReturn,
        evaluatedBars,
        skippedFolds: Math.max(0, possibleFolds - foldCount),
    };
}

function byEntryIndex(left: Trade, right: Trade): number {
    return left.entryIndex - right.entryIndex;
}

function emptyResult(options: WalkForwardOptions): WalkForwardResult {
    const empty = calculateMetrics(
        [],
        [],
        { long: 0, short: 0, neutral: 0 },
        options.barsPerYear,
    );

    return {
        folds: [],
        trades: [],
        overall: empty,
        baseline: empty,
        benchmarks: {
            buyAndHold: {
                label: 'Buy & hold',
                trades: 0,
                totalReturn: 0,
                maxDrawdown: 0,
                sharpeRatio: 0,
            },
            randomEntry: {
                label: 'Случайный вход',
                trades: 0,
                totalReturn: 0,
                maxDrawdown: 0,
                sharpeRatio: 0,
            },
        },
        // Nothing was evaluated, so nothing was beaten.
        excessOverBuyAndHold: null,
        evaluatedBars: 0,
        skippedFolds: 0,
    };
}
