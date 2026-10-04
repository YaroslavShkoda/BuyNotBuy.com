/**
 * What does the walk-forward bar look like from the inside?
 *
 * `walkForwardStrategy` calls a rule consistent when at least 60% of its folds
 * are profitable and its worst fold is positive. Those numbers were picked
 * because they read as reasonable, and they have been used to say that nothing
 * in this project has ever passed. A threshold nobody justified is a threshold
 * nobody can check, and a bar that no rule clears is just as uninformative as
 * one that clears everything.
 *
 * So: what would the bar say about rules that know nothing?
 *
 * Random long-only signals, fired at roughly the exposure real rules use, run
 * through the same walk-forward on the same bars with the same costs. They
 * contain no market hypothesis, so every number they produce is the drift and
 * the fold boundaries talking. If a coin clears the bar at some rate, the bar
 * is measuring the coin.
 *
 * **The answer is that the bar does not measure what it was written to
 * measure.** On Binance BTCUSDT, 2096 daily bars, folds of 250, 400 random
 * rules at 40% exposure: not one of them had a positive worst fold, and the
 * best reached 75% of folds profitable with a worst fold of -18.7%.
 *
 * So the 60% share clause is not the gate. Random rules clear it routinely, and
 * the real rule that scored highest in this project clears it too — 62.5% is
 * within what a coin gets. The clause doing all the work is `worstFold > 0`,
 * which has no justification written down anywhere and which no long-only rule
 * paying costs can clear, because costs plus a non-zero exposure guarantee at
 * least one losing window.
 *
 * That is why nothing in this project has ever passed walk-forward, and it is
 * not evidence about any rule. It is arithmetic about fees.
 *
 * What this does not license is replacing the bar with a loose one on the
 * strength of the fold-share clause being cheap. A clause a coin passes is not
 * a clause to pass on. The bar needs a real criterion — a significance test
 * against these same coins, which `signal-power.ts` already knows how to run —
 * and until then the honest statement is that walk-forward as specified cannot
 * distinguish a rule from a coin, in either direction.
 */

import { readFileSync } from 'node:fs';
import type { Candle } from '../types/market.js';
import { mulberry32 } from './signal-power.js';
import type { Strategy } from './strategies.js';
import type { WalkForwardVerdict } from './strategy-walk-forward.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';

export const DEFAULT_FOLD_BARS = 250;
export const DEFAULT_RULES = 400;
export const DEFAULT_EXPOSURE = 0.4;
export const DEFAULT_SEED = 0x7a1e_5e11;

export interface PassRates {
    /** Share of rules clearing "≥ share of folds positive AND worst fold > 0". */
    readonly atHalf: number;
    readonly atSixty: number;
    readonly atSeventy: number;
    /**
     * Share clearing the fold-share condition *alone*, with no worst-fold
     * clause.
     *
     * This is the number that shows which half of the bar is doing the work,
     * and on this data the answer is that almost none of it is: random rules
     * clear 60% of folds positive routinely.
     */
    readonly shareOnly: number;
    /** Share clearing `worstFold > 0` alone, with no fold-share clause. */
    readonly worstOnly: number;
    /** The most profitable fold share any random rule managed. */
    readonly bestProfitableShare: number;
    /** The best worst-fold any random rule managed. */
    readonly bestWorstFold: number;
    readonly rules: number;
    readonly folds: number;
    /** The most folds a single random rule had. Used to spot a silent no-op. */
    readonly mostTrades: number;
}

export function loadDaily(file: string): Candle[] {
    return readFileSync(
        new URL(`../backtest/fixtures/${file}`, import.meta.url),
        'utf8',
    )
        .split(/\r?\n/u)
        .filter((line) => line.trim() !== '')
        .slice(1)
        .map((line) => {
            const [t, o, h, lo, cl, v] = line.split(',');

            return {
                timestamp: Number(t),
                open: Number(o),
                high: Number(h),
                low: Number(lo),
                close: Number(cl),
                volume: Number(v),
            };
        });
}

/**
 * A rule with no hypothesis in it.
 *
 * Fires long on a fixed fraction of bars, drawn from a seeded generator so the
 * answer is the same on every run and comparable with the previous run's. A
 * fraction rather than a fixed cadence, because a rule trading every seventh
 * bar has a period that can align with the fold boundaries and look consistent
 * for reasons that have nothing to do with the market.
 */
export function randomLongRule(
    seed: number,
    exposure: number,
    length: number,
): Strategy {
    const random = mulberry32(seed);

    return {
        name: `random-${seed}`,
        mechanism:
            'A long signal fired at random, carrying no claim about the market. ' +
            'The control for what a walk-forward verdict looks like with nothing ' +
            'behind it.',
        warmup: 0,
        decide({ index }) {
            if (index < length) {
                return 0;
            }

            return random() < exposure ? 1 : 0;
        },
    };
}

/** Does this verdict clear a bar of `share` profitable folds and a positive worst fold? */
export function clears(verdict: WalkForwardVerdict, share: number): boolean {
    return verdict.profitableShare >= share && verdict.worstFold > 0;
}

export function measurePassRates(
    candles: readonly Candle[],
    options: {
        readonly rules?: number;
        readonly exposure?: number;
        readonly foldBars?: number;
        readonly seed?: number;
    } = {},
): PassRates {
    const rules = options.rules ?? DEFAULT_RULES;
    const exposure = options.exposure ?? DEFAULT_EXPOSURE;
    const foldBars = options.foldBars ?? DEFAULT_FOLD_BARS;
    const seed = options.seed ?? DEFAULT_SEED;

    let half = 0;
    let sixty = 0;
    let seventy = 0;
    let shareOnly = 0;
    let worstOnly = 0;
    let bestProfitableShare = 0;
    let bestWorstFold = Number.NEGATIVE_INFINITY;
    let folds = 0;
    let mostTrades = 0;

    for (let rule = 0; rule < rules; rule += 1) {
        const verdict = walkForwardStrategy(
            randomLongRule(seed + rule, exposure, 20),
            candles,
            { foldBars, barsPerYear: 365 },
        );

        folds = verdict.folds.length;
        mostTrades = Math.max(
            mostTrades,
            verdict.folds.reduce((sum, fold) => sum + fold.trades, 0),
        );
        half += clears(verdict, 0.5) ? 1 : 0;
        sixty += clears(verdict, 0.6) ? 1 : 0;
        seventy += clears(verdict, 0.7) ? 1 : 0;
        shareOnly += verdict.profitableShare >= 0.6 ? 1 : 0;
        worstOnly += verdict.worstFold > 0 ? 1 : 0;
        bestProfitableShare = Math.max(bestProfitableShare, verdict.profitableShare);
        bestWorstFold = Math.max(bestWorstFold, verdict.worstFold);
    }

    return {
        atHalf: half / rules,
        atSixty: sixty / rules,
        atSeventy: seventy / rules,
        shareOnly: shareOnly / rules,
        worstOnly: worstOnly / rules,
        bestProfitableShare,
        bestWorstFold,
        rules,
        folds,
        mostTrades,
    };
}
