/**
 * A bar for walk-forward that a coin cannot walk through.
 *
 * The current one — 60% of folds profitable, worst fold positive — was measured
 * and found to be a bar nothing passes and nothing should: 400 random rules
 * cleared it 0.0% of the time, and `threshold-null.ts` showed why. The 60%
 * clause is cheap, coins clear it 4.3% of the time, and the clause actually
 * filtering is `worstFold > 0`, which no long-only rule paying costs can clear.
 * So that bar is a statement about commission, not about a rule, and it was
 * left in place because a bar that is easy is not made informative by relaxing
 * it. What it needs instead is a real criterion. This is it.
 *
 * **A rule is compared with the coins that trade about as much as it does.**
 *
 * That clause is the whole design, and it was missing from every version of
 * this project. A rule in the market 12% of the time and a coin in it 40% of
 * the time are not comparable on any of the numbers walk-forward produces —
 * not on returns, not on fold count, not on profit factor. Comparing them anyway
 * is how a rule that simply trades less gets to look disciplined.
 *
 * So the control is drawn per rule, from coins matched on exposure. The test is
 * then a percentile: where does this rule's profitable-fold share sit among
 * rules with its own trading frequency and no opinion about the market?
 *
 * The threshold, at last, is a number someone wrote down. It is the same 5% a
 * significance test means everywhere else, and it is worth saying why it is
 * that and not something friendlier: a criterion a coin passes at 5% will let
 * one coin in twenty through, and there are thousands of rules in the world
 * that somebody will try. Five per cent of all of them is not a small number
 * of false positives. The walk-forward pass rate in the previous design was 0%
 * because nothing was compared to anything; this one is 5% because five per
 * cent of the field is the price of asking a question with an answer.
 *
 * **On this data nothing passes it, but the honest reading of that is weaker
 * than it looks, and the reason is the statistic rather than the rules.**
 *
 * `volatility-trend` lands at p = 0.050 — exactly on the line, failing a strict
 * `<`. With 80 matched coins one coin is 1.25% of a percentile, so the
 * resolution of this test is about ±0.0125 and 0.050 cannot be told apart from
 * the threshold it failed. And the statistic itself is coarse: eight folds mean
 * the profitable share can only take nine values, and 62.5% is one of them. A
 * test built on a nine-valued statistic is a real test, and a blunt one.
 *
 * That also explains why this p and the signal permutation p disagree so
 * sharply — 0.050 here against 0.7956 there. They ask different questions. The
 * permutation asks whether the signal *times* the market; this asks whether the
 * fold share beats coins trading as often. The second is much weaker evidence,
 * because fold share barely resolves at all.
 *
 * So the useful conclusion is not "nothing passed, therefore it is settled".
 * It is: **the fold-share statistic cannot carry a significance test, which is
 * the second independent reason the walk-forward summary needs replacing** —
 * the first being that its threshold was never justified. What the test does
 * establish, and what four independent measurements now agree on, is that no
 * rule here is separable from coins trading as often as it does.
 */

import { randomLongRule } from './threshold-null.js';
import { walkForwardStrategy } from './strategy-walk-forward.js';

import type { Strategy } from './strategies.js';
import type { Candle } from '../types/market.js';

/**
 * Fraction of matched coins a rule must beat to be called an edge.
 *
 * Five per cent is the conventional significance level and the reasoning is in
 * the module comment: a looser gate lets one rule in twenty through, and there
 * are far more than twenty rules anybody will try.
 */
export const SIGNIFICANCE_LEVEL = 0.05;

/** How far apart two rules' trading frequencies may be and still be compared. */
export const EXPOSURE_TOLERANCE = 0.1;

export interface RuleProfile {
    readonly key: string;
    /** Share of bars the rule was in the market. */
    readonly exposure: number;
    /** Share of folds that made money. */
    readonly profitableShare: number;
    readonly worstFold: number;
    readonly bestFold: number;
    readonly folds: number;
    readonly trades: number;
}

/**
 * Share of bars on which a strategy held a position.
 *
 * Measured, not declared. A module that says it trades a lot and a module that
 * says the same thing are the same kind of claim, and both can be wrong; the
 * only version worth matching on is the one the bar count can check.
 */
export function measureExposure(strategy: Strategy, candles: readonly Candle[]): number {
    let inMarket = 0;

    for (let index = 0; index < candles.length; index += 1) {
        if (strategy.decide({ candles, series: {}, index }) !== 0) {
            inMarket += 1;
        }
    }

    return inMarket / candles.length;
}

export function profileOf(
    key: string,
    strategy: Strategy,
    candles: readonly Candle[],
    foldBars: number,
): RuleProfile {
    const verdict = walkForwardStrategy(strategy, candles, { foldBars, barsPerYear: 365 });
    const trades = verdict.folds.reduce((total, fold) => total + fold.trades, 0);

    return {
        key,
        exposure: measureExposure(strategy, candles),
        profitableShare: verdict.profitableShare,
        worstFold: verdict.worstFold,
        bestFold: verdict.bestFold,
        folds: verdict.folds.length,
        trades,
    };
}

export interface Comparison {
    readonly key: string;
    readonly profile: RuleProfile;
    /** Coins whose exposure was close enough to compare. */
    readonly matchedCoins: number;
    /** Share of matched coins whose fold share is at least the rule's. */
    readonly pValue: number;
    /** The best fold share any matched coin reached. */
    readonly bestCoinShare: number;
    /** True when the rule beat enough coins. */
    readonly significant: boolean;
}

/**
 * Where a rule sits among coins that trade as much as it does.
 *
 * The p-value is the share of matched coins at or above the rule. A rule
 * scoring higher than 95% of them clears the bar; one that ties with the
 * typical coin does not, and neither does one that loses.
 *
 * The matched set is the entire coin population minus the ones whose exposure
 * is too far away, and the size of what was left is reported, because a
 * percentile over four coins is not a percentile.
 */
export function compareAgainstCoins(
    profile: RuleProfile,
    coins: readonly RuleProfile[],
    level: number = SIGNIFICANCE_LEVEL,
): Comparison {
    const matched = coins.filter(
        (coin) => Math.abs(coin.exposure - profile.exposure) <= EXPOSURE_TOLERANCE,
    );

    if (matched.length === 0) {
        return {
            key: profile.key,
            profile,
            matchedCoins: 0,
            pValue: 1,
            bestCoinShare: Number.NaN,
            significant: false,
        };
    }

    const atLeastAsGood = matched.filter(
        (coin) => coin.profitableShare >= profile.profitableShare,
    ).length;

    return {
        key: profile.key,
        profile,
        matchedCoins: matched.length,
        pValue: atLeastAsGood / matched.length,
        bestCoinShare: Math.max(...matched.map((coin) => coin.profitableShare)),
        significant: atLeastAsGood / matched.length < level,
    };
}

/** Profiles a population of random rules, all on the same series. */
export function coinPopulation(
    candles: readonly Candle[],
    options: {
        readonly count: number;
        readonly foldBars: number;
        readonly exposures: readonly number[];
        readonly seed: number;
    },
): RuleProfile[] {
    const profiles: RuleProfile[] = [];

    for (let index = 0; index < options.count; index += 1) {
        const exposure =
            options.exposures[index % options.exposures.length]!;

        profiles.push(
            profileOf(
                `coin-${index}`,
                randomLongRule(options.seed + index, exposure, 20),
                candles,
                options.foldBars,
            ),
        );
    }

    return profiles;
}
