import { donchianInputs } from './donchian.js';
import {
    atrSeries,
    breakoutStrength,
    isReady,
    latest,
    smaSeries,
} from './series.js';
import { NEUTRAL_DECISION } from './types.js';

import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';

/**
 * The rule the backtest chose, and then stopped supporting.
 *
 * Two ideas welded together: a twenty-bar breakout says *when to enter*, and a
 * volatility test says *whether that entry counts*. The version of this comment
 * written before the bench and the running system were made to share one
 * implementation of the indicators claimed the rule made 23.96% and that the
 * gate was carrying it. Both claims were artefacts of measuring the breakout
 * channel against a level two bars stale, and the corrected numbers are below.
 *
 * **The rule as written loses money.** Over 2018—2026 on daily BTCUSDT with
 * costs: −13.31%, profit factor 0.965, 127 trades, 10.51% exposure. In the
 * first half of that sample, −20.86%.
 *
 * **The gate runs backwards.** An ablation with the gate inverted — the same
 * breakout, entered precisely when the volatility test forbids it — makes
 * +33.58% where this rule makes −13.31%, and wins in both halves of the sample
 * too. So whatever the volatility test is doing here, it is not "keep the
 * breakouts taken while the market is moving". Breakouts in a quiet market are
 * the ones worth taking, which is a plausible mechanism: a calm drift to a new
 * high is accumulation, while a high-volatility break is more often a spike
 * that comes back. That reading is a hypothesis and nothing more — it was
 * derived by looking at the result, on the data that will be used to test it,
 * and it is worth exactly nothing until it survives data it has not seen.
 *
 * **The gate is barely a gate.** Volatility is above its own forty-bar mean in
 * 47.22% of bars, and the gate passes 53.52% of the 327 breakouts it is
 * offered. A filter that lets slightly more than half through is a coin flip
 * with an indicator attached, which is the most likely reason its direction
 * could flip without anyone noticing.
 *
 * **What does survive is the bare breakout.** With the gate removed entirely,
 * the same twenty-bar rule makes +21.80%, and +27.36% in the second half. It
 * is the part of this strategy worth keeping, and `donchian.ts` is a module
 * holding exactly that.
 *
 * This module is nevertheless still here, and still the default fallback,
 * because a user asked for this rule by name and because shipping a losing
 * candidate in shadow mode is how a candidate is supposed to arrive. It is in
 * shadow: it is evaluated every cycle and cannot change a published signal.
 * The number to watch is how often it would have disagreed.
 */

export interface DonchianTrendGatedConfig {
    /** Bars in the breakout channel. */
    readonly channelPeriod: number;
    /** ATR period. */
    readonly atrPeriod: number;
    /** Bars averaged to make the volatility benchmark. */
    readonly atrBaselinePeriod: number;
}

export const DONCHIAN_TREND_GATED_CONFIG: DonchianTrendGatedConfig = {
    channelPeriod: 20,
    atrPeriod: 14,
    atrBaselinePeriod: 40,
};

export function createDonchianTrendGated(
    config: DonchianTrendGatedConfig = DONCHIAN_TREND_GATED_CONFIG,
): StrategyModule {
    const warmup = Math.max(
        config.channelPeriod,
        config.atrPeriod + config.atrBaselinePeriod,
    ) + 1;

    return {
        key: 'donchian-trend-gated',
        name: `Пробой ${config.channelPeriod} (${config.atrPeriod}/${config.atrBaselinePeriod})`,
        mechanism:
            'Trends persist, so a level that took twenty bars to set is worth ' +
            'more than one that took two. A breakout above it is evidence of ' +
            'demand and the exit is the far side of the same channel, so a ' +
            'winner is held and a loser is cut at the same distance. The ' +
            'volatility test keeps only the breakouts taken while the market is ' +
            'actually moving. Mechanism: long-horizon momentum, restricted to ' +
            'the conditions it works in.',
        warmup,

        evaluate(context: StrategyContext): StrategyDecision {
            const inputs = donchianInputs(
                context.candles,
                warmup,
                config.channelPeriod,
            );

            if (!inputs.ready) {
                return inputs.decision;
            }

            const { channelHigh, channelLow, last } = inputs;
            const atr = latest(atrSeries(context.candles, config.atrPeriod));
            const atrBaseline = latest(
                smaSeries(
                    atrSeries(context.candles, config.atrPeriod),
                    config.atrBaselinePeriod,
                ),
            );

            if (!isReady(channelHigh, channelLow, atr, atrBaseline)) {
                return NEUTRAL_DECISION(
                    'Индикаторы правила ещё не прогрелись',
                    true,
                );
            }

            // Measured, not assumed: this test is true in 47.22% of bars and
            // passes 54.75% of the breakouts it is given. A filter that lets
            // slightly more than half through is close to a coin flip, which is
            // why this rule has two opposite regime profiles depending on which
            // half of it you keep.
            if (atr <= atrBaseline) {
                return NEUTRAL_DECISION(
                    'Волатильность ниже своей средней — правило ждёт',
                );
            }

            if (last.close > channelHigh) {
                return {
                    direction: 'LONG',
                    confidence: breakoutStrength(last.close, channelHigh, atr),
                    reason:
                        `Пробой максимума за ${config.channelPeriod} баров ` +
                        `при повышенной волатильности`,
                    warm: false,
                };
            }

            if (last.close < channelLow) {
                return {
                    direction: 'SHORT',
                    confidence: breakoutStrength(channelLow, last.close, atr),
                    reason:
                        `Пробой минимума за ${config.channelPeriod} баров ` +
                        `при повышенной волатильности`,
                    warm: false,
                };
            }

            return NEUTRAL_DECISION(
                'Цена внутри канала, направленного пробоя нет',
            );
        },
    };
}
