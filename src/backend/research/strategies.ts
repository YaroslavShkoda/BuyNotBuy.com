import { z } from 'zod';

import { EXECUTION_CONFIG, fillPrice, pricedTrade } from '../backtest/execution.js';
import {
    atrSeries,
    emaSeries,
    isReady,
    priorRolling,
    rsiSeries,
    smaSeries,
} from '../strategies/series.js';
import { calculateMetrics, benchmarkMetrics } from '../backtest/metrics.js';
import { createDonchian } from '../strategies/donchian.js';
import { createDonchianTrendGated } from '../strategies/donchian-trend-gated.js';

import type { ExecutionConfig } from '../backtest/execution.js';
import type { BacktestMetrics, Trade } from '../backtest/metrics.js';
import type { Candle } from '../types/market.js';
import type { StrategyModule } from '../strategies/types.js';

/**
 * Candidate strategies, and the only honest way to compare them.
 *
 * Two rules govern this file, and both exist because the alternative is a
 * number that looks like a result and is not one.
 *
 * The first is that every strategy is a **hypothesis with a stated mechanism**,
 * written down before it is run. "Buy when price crosses above its 200-period
 * average" is a claim about why money would be made: that a trend, once
 * established, persists long enough to pay for the round trip. A threshold
 * plucked from a grid until the backtest went green has no mechanism, and a
 * mechanism is what tells you which of two backtests to believe when they
 * disagree. Every strategy here carries one, and the ones that fail keep it.
 *
 * The second is that a **strategy is not the thing being selected — the
 * strategy is the thing being tested.** Try ten rules on one series and report
 * the best and you have measured your own search, not the market: the winner's
 * number includes the eight losers that led you to it. So every strategy is
 * reported, winners and losers, next to each other, and each is also run
 * walk-forward — fitted on the past, measured on bars it has not seen. A rule
 * that only works on the window it was chosen on is reported as such, which is
 * the finding rather than a disappointment about it.
 *
 * Causality is structural. Every indicator here is built by a function that
 * only ever reads backwards from the index it fills, and a test appends bars to
 * a series and checks that no earlier decision moves. A strategy that peeks is
 * not merely wrong, it is wrong in the direction that makes the result look
 * good, which is why the check is a test and not a promise.
 */

export type Decision = 1 | 0 | -1;

export interface Strategy {
    readonly name: string;
    /**
     * Why this should make money at all.
     *
     * Read before the result. A strategy whose mechanism cannot be stated in a
     * sentence is a curve with a name on it.
     */
    readonly mechanism: string;
    /** Bars needed before the first decision is meaningful. */
    readonly warmup: number;
    /** The position to hold from the close of bar `index` onwards. */
    decide(context: DecisionContext): Decision;
}

export interface DecisionContext {
    readonly candles: readonly Candle[];
    readonly index: number;
    /** Rolling series, each element depending only on that bar and earlier. */
    readonly series: Readonly<Record<string, readonly number[]>>;
}

// ---------------------------------------------------------------------------
// Causal series. Each of these reads only backwards from the index it fills.
// ---------------------------------------------------------------------------

const at = (series: readonly number[], index: number): number => series[index] ?? NaN;

// ---------------------------------------------------------------------------
// The candidates. Each says why it should work before it is run.
// ---------------------------------------------------------------------------

/**
 * Runs a production module as a bench candidate.
 *
 * The bench used to carry its own copy of every rule — its own `decide` for
 * donchian, its own for the gated variant — and the copies drifted. They
 * drifted by exactly one bar, and when the two were made to share one
 * implementation of the indicator series the drift became visible and
 * corrected every number the bench had produced: the rule recommended in the
 * two commits before went from +23.96% to -13.31%. Two copies of a rule is the
 * ordinary way that a backtest ends up describing a strategy nobody is trading.
 *
 * So the bench no longer describes any rule. It calls the same module the
 * server calls, and the price is paid in speed: the module's contract is
 * index-free, so a backtest that wants bar `i` has to hand it
 * `candles.slice(0, i + 1)` and let it recompute. That is quadratic, and for a
 * research command run a handful of times over a few thousand bars it is a
 * price worth paying. What it buys is that a number in the bench and a signal
 * in production cannot be about different rules.
 *
 * `label` is separate from `module.name` because the module's name is a
 * Russian phrase meant for a person, and the bench's tables are keyed on a
 * stable identifier that a rename must not silently change.
 */
export function fromModule(label: string, module: StrategyModule): Strategy {
    return {
        name: label,
        mechanism: module.mechanism,
        warmup: module.warmup,
        decide({ candles, index }) {
            // Bars the module has not warmed up on cannot produce a decision,
            // and it is already required to say so. Calling it anyway to be
            // told is avoidable work: the call is over the whole visible
            // history, so a 900-bar warmup on a 2096-bar series is 43% of the
            // *calls* spent asking a question whose answer is already written
            // in `module.warmup`.
            //
            // `index + 1 < warmup`, not `index < warmup`. A module declaring
            // `warmup: 900` needs 900 bars and is ready on the bar where it
            // has them — which is index 899, not 900. The first version of this
            // skipped one bar too many, so a 900-bar rule started a bar late
            // and every number downstream of it was quietly wrong. A test that
            // compared this path against a module that honours its own warmup
            // found it; nothing else would have.
            //
            // Exact, not an approximation — a module that returned a direction
            // during its own warmup would be violating its contract, and
            // `warm` is in the return type so that it cannot do so silently.
            //
            // It is also worth only 4% of the runtime, and the reason is worth
            // keeping: cost sits almost entirely in the last bars, where the
            // visible history is longest, and the bars being skipped are the
            // early ones where a call is cheap. See `bench-cost.ts`, which is
            // the measurement rather than an assertion that this helped.
            if (index + 1 < module.warmup) {
                return 0;
            }

            const visible = candles.slice(0, index + 1);
            const decision = module.evaluate({
                candles: visible,
                price: visible[visible.length - 1]!.close,
            });

            if (decision.direction === 'LONG') {
                return 1;
            }

            return decision.direction === 'SHORT' ? -1 : 0;
        },
    };
}

export const CANDIDATE_STRATEGIES: readonly Strategy[] = [
    {
        name: 'buy-and-hold',
        mechanism:
            'The benchmark, not a candidate. On an asset that rose over the ' +
            'period, doing nothing and being present is the thing every other ' +
            'rule has to beat. A strategy that cannot beat it is not a strategy.',
        warmup: 1,
        decide: (context) => (context.index >= 1 ? 1 : 0),
    },
    // The rule itself lives in strategies/donchian.ts. See fromModule.
    fromModule('donchian-20', createDonchian()),

    {
        name: 'donchian-55-long-only',
        mechanism:
            'The same edge, over a longer window, without the short side. ' +
            'Shorting a asset that trended up for years needs a borrow that ' +
            'costs money and a venue that allows it; a rule that cannot be ' +
            'acted on where it was found is not a rule.',
        warmup: 55,
        decide: (context) => {
            const { candles, index, series } = context;

            if (!isReady(at(series.high55!, index), at(series.high55p1!, index))) {
                return 0;
            }

            if (candles[index]!.close > at(series.high55p1!, index)) {
                return 1;
            }

            if (candles[index]!.close < at(series.low55p1!, index)) {
                return 0;
            }

            return 1;
        },
    },
    {
        name: 'ema-crossover-20-50',
        mechanism:
            'The canonical trend rule. A short average crossing a long one is a ' +
            'statement about the balance of recent buying against recent ' +
            'selling, and it is slow enough not to be fooled by one candle. ' +
            'Mechanism: the same momentum, filtered by averaging.',
        warmup: 50,
        decide: (context) => {
            const fast = at(series20(context, 'ema20'), context.index);
            const slow = at(series20(context, 'ema50'), context.index);

            if (!isReady(fast, slow)) {
                return 0;
            }

            return fast > slow ? 1 : -1;
        },
    },
    {
        name: 'bollinger-reversion',
        mechanism:
            'Price is pulled back to its mean after a stretch away from it. ' +
            'Buying the lower band and exiting at the middle assumes the ' +
            'stretch is noise rather than a new level. Mechanism: mean ' +
            'reversion — which is also why this one is expected to fail in a ' +
            'trend, and the run is worth having precisely to show that.',
        warmup: 20,
        decide: (context) => {
            const price = context.candles[context.index]!.close;
            const lower = at(context.series.lower!, context.index);
            const upper = at(context.series.upper!, context.index);
            const middle = at(context.series.middle!, context.index);

            if (!isReady(lower, upper, middle)) {
                return 0;
            }

            if (price < lower) {
                return 1;
            }

            if (price > upper) {
                return -1;
            }

            return 0;
        },
    },
    {
        name: 'rsi-reversion',
        mechanism:
            'The same mean-reversion claim through a different measure: after ' +
            'a large run of one direction, the move has overshot something. ' +
            'Mechanism: reversion, and a test of whether the claim survives ' +
            'being expressed twice in two different ways.',
        warmup: 15,
        decide: (context) => {
            const rsi = at(context.series.rsi!, context.index);

            if (!Number.isFinite(rsi)) {
                return 0;
            }

            if (rsi < 30) {
                return 1;
            }

            if (rsi > 70) {
                return -1;
            }

            return 0;
        },
    },
    // And this one in strategies/donchian-trend-gated.ts, for the same reason.
    fromModule('donchian-trend-gated', createDonchianTrendGated()),
];

/**
 * The per-candle series a strategy may read.
 *
 * Built once for the whole sample and passed by reference, because recomputing
 * an EMA for every bar of a fold turns a cheap run into an expensive one and
 * invites a difference in the arithmetic between the two paths.
 */
export function buildSeries(candles: readonly Candle[]): Record<string, number[]> {
    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const middle = smaSeries(closes, 20);
    const deviation = new Array<number>(closes.length).fill(NaN);

    for (let i = 0; i < closes.length; i += 1) {
        if (!Number.isFinite(middle[i])) {
            continue;
        }

        let sum = 0;
        let count = 0;

        for (let j = i - 19; j <= i; j += 1) {
            sum += (closes[j]! - middle[i]!) ** 2;
            count += 1;
        }

        deviation[i] = Math.sqrt(sum / count);
    }

    return {
        close: closes,
        high20: priorRolling(highs, 20, 'max'),
        low20: priorRolling(lows, 20, 'min'),
        // As of the previous bar. A breakout measured against a window that
        // contains the bar being measured is trivially inside its own channel,
        // and the earlier version of this file did exactly that.
        high20p1: priorRolling(highs, 20, 'max'),
        low20p1: priorRolling(lows, 20, 'min'),
        high55: priorRolling(highs, 55, 'max'),
        high55p1: priorRolling(highs, 55, 'max'),
        low55p1: priorRolling(lows, 55, 'min'),
        ema20: emaSeries(closes, 20),
        ema50: emaSeries(closes, 50),
        rsi: rsiSeries(closes, 14),
        atr: atrSeries(candles, 14),
        atrSlow: smaSeries(atrSeries(candles, 14), 40),
        middle,
        upper: middle.map((value, i) =>
            Number.isFinite(value) ? value + 2 * deviation[i]! : NaN,
        ),
        lower: middle.map((value, i) =>
            Number.isFinite(value) ? value - 2 * deviation[i]! : NaN,
        ),
    };
}

// The ema-crossover rule reads two series by name; this keeps its `decide`
// body free of a lookup helper it would otherwise need defined first.
function series20(context: DecisionContext, name: string): readonly number[] {
    return context.series[name] ?? [];
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface StrategyRun {
    readonly strategy: string;
    readonly mechanism: string;
    readonly metrics: BacktestMetrics;
    readonly benchmarks: { buyAndHold: number; randomEntry: number };
}

export interface RunOptions {
    execution?: ExecutionConfig;
    barsPerYear?: number;
}

/**
 * Run one strategy over a slice of candles.
 *
 * The entry is always on the bar **after** the decision. A decision made at the
 * close of bar `i` knows closes up to `i` and nothing else, so filling on bar
 * `i` would be using that bar's open — a price observed before the information
 * that produced the trade. This is the single most common way a backtest
 * manufactures a profit, and it costs one line to refuse.
 */
/**
 * Run one strategy over a slice of candles.
 *
 * The timing rule is the whole correctness of this function, and it is one
 * sentence: **a decision made at the close of bar i is filled on bar i+1.**
 *
 * The first version of this runner got that wrong in the most flattering way
 * available. It decided at the close of bar i and then priced the entry from
 * bar i's own open — a price that had been printed before the information that
 * produced the trade. It produced returns in the tens of thousands of percent,
 * which is what a backtest looks like when it is being fed a future. Two lines
 * moved the fill, and the strategy went from 319,000% to something a person
 * might act on. Nothing about the strategy changed; only the cheating did.
 *
 * The loop is therefore written as two passes over the same bar: orders decided
 * at the previous close execute here, and only then is the bar's close used to
 * decide what happens next. An order can never be filled on a bar whose close
 * produced it.
 */
export function runStrategy(
    strategy: Strategy,
    candles: readonly Candle[],
    options: RunOptions = {},
): StrategyRun {
    const config = options.execution ?? EXECUTION_CONFIG;
    const barsPerYear = options.barsPerYear ?? 365;
    const series = buildSeries(candles);

    const trades: Trade[] = [];
    const equity: number[] = [];
    const mix = { long: 0, short: 0, neutral: 0 };

    const start = Math.max(1, strategy.warmup);

    let cash = 1;
    let position: 1 | -1 | 0 = 0;
    let entryIndex = -1;
    let entryPrice = 0;
    let pendingExit = false;

    const markToMarket = (index: number): number => {
        if (position === 0) {
            return 0;
        }

        const exitPrice = fillPrice(candles[index]!, position, config, false);

        return position * (exitPrice / entryPrice - 1);
    };

    for (let index = start; index < candles.length; index += 1) {
        // Orders decided at the close of the previous bar execute on this one.
        if (pendingExit && position !== 0) {
            const exitPrice = fillPrice(candles[index]!, position, config, false);
            const netReturn = position * (exitPrice / entryPrice - 1);
            const grossReturn =
                position *
                (candles[index]!.close / candles[entryIndex]!.open - 1);

            trades.push({
                entryIndex,
                exitIndex: index,
                direction: position,
                entryPrice,
                exitPrice,
                netReturn,
                grossReturn,
            });

            cash *= 1 + netReturn;
            position = 0;
            pendingExit = false;
        }

        // The account at this bar's close, with any open position marked at the
        // price it could be sold at now. A dip inside a position belongs in the
        // curve, not only in the trade that happened to end inside it.
        equity.push(cash * (1 + markToMarket(index)));

        // Decide at the close. Whatever this returns can only be acted on next
        // bar, which is the entire guarantee.
        const decision = strategy.decide({ candles, index, series });

        if (decision === 1) {
            mix.long += 1;
        } else if (decision === -1) {
            mix.short += 1;
        } else {
            mix.neutral += 1;
        }

        if (position !== 0 && decision !== position) {
            pendingExit = true;
        } else if (position === 0 && decision !== 0 && index + 1 < candles.length) {
            position = decision;
            entryIndex = index + 1;
            entryPrice = fillPrice(candles[index + 1]!, decision, config, true);
        }
    }

    // Close whatever is still open. Without this the strategy that holds
    // through the end of the sample — which is what buy and hold does, and
    // which the best rule usually does — reports zero trades and a flat line,
    // making the winner look like the worst result in the table.
    if (position !== 0) {
        const index = candles.length - 1;
        const exitPrice = fillPrice(candles[index]!, position, config, false);
        const netReturn = position * (exitPrice / entryPrice - 1);
        const grossReturn =
            position * (candles[index]!.close / candles[entryIndex]!.open - 1);

        trades.push({
            entryIndex,
            exitIndex: index,
            direction: position,
            entryPrice,
            exitPrice,
            netReturn,
            grossReturn,
        });

        cash *= 1 + netReturn;
        equity.push(cash);
    }

    const metrics = calculateMetrics(trades, equity, mix, barsPerYear);
    const first = candles[start]!.close;
    const last = candles[candles.length - 1]!.close;

    return {
        strategy: strategy.name,
        mechanism: strategy.mechanism,
        metrics,
        benchmarks: {
            buyAndHold: last / first - 1,
            // One benchmark for the whole sample, not one per strategy. A
            // benchmark that changes with the strategy it is judging is not a
            // benchmark, and the difference between two strategies would then
            // partly be a difference in how their first bar fell.
            randomEntry: randomEntryBenchmark(candles, config, barsPerYear),
        },
    };
}

/**
 * The same number of trades, the same holding period, the same price path, and
 * no information at all.
 *
 * This is the sharper of the two benchmarks, and it is the one that catches
 * what buy and hold cannot. A strategy that cannot beat an equal number of
 * random entries over the same bars is reading noise, and the reason is
 * mechanical: two hundred and ninety round trips on daily bars pay the cost
 * model two hundred and ninety times, so at this trade frequency the cost alone
 * decides the answer and no edge survives it.
 *
 * Fixed start and a seeded direction, deliberately. The first version of this
 * benchmark started at each strategy's own warmup and alternated direction,
 * which produced +405% for one row and −99.9% for the next. That was not a
 * difference between strategies; it was a difference in where a series of
 * ninety compounding round trips happened to start. Two hundred and ninety
 * trades at a small negative edge do not produce −99.9% gradually, they produce
 * it exponentially, so the sign of the whole run is decided by the first bar.
 * A benchmark that changes its answer when the first bar moves is measuring the
 * start date, and one number for the whole sample is the only version of it
 * that can be compared down a column.
 */
function randomEntryBenchmark(
    candles: readonly Candle[],
    config: ExecutionConfig,
    barsPerYear: number,
): number {
    const trades: Trade[] = [];
    const mix = { long: 0, short: 0, neutral: 0 };
    const holdBars = 10;
    const start = 60;
    let cash = 1;

    // mulberry32, seeded. A benchmark that is genuinely random gives a different
    // answer on every run, which makes a table impossible to read and a
    // regression impossible to spot.
    let seed = 0x9e3779b9;
    const next = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;

        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };

    for (let index = start; index + holdBars < candles.length; index += holdBars) {
        const direction: 1 | -1 = next() < 0.5 ? 1 : -1;
        const priced = pricedTrade(
            candles[index]!,
            candles[index + holdBars]!,
            direction,
            config,
        );

        trades.push({
            entryIndex: index,
            exitIndex: index + holdBars,
            direction,
            entryPrice: priced.entryPrice,
            exitPrice: priced.exitPrice,
            netReturn: priced.netReturn,
            grossReturn: priced.grossReturn,
        });

        cash *= 1 + priced.netReturn;
    }

    const equity = new Array<number>(candles.length - start).fill(cash);

    return calculateMetrics(trades, equity, mix, barsPerYear).totalReturn;
}

export { benchmarkMetrics };

export const StrategyNameSchema = z.enum([
    'buy-and-hold',
    'donchian-20',
    'donchian-55-long-only',
    'ema-crossover-20-50',
    'bollinger-reversion',
    'rsi-reversion',
    'donchian-trend-gated',
]);
