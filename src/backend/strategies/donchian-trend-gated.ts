import {
    atrSeries,
    isReady,
    latest,
    priorRolling,
    smaSeries,
} from './series.js';
import { NEUTRAL_DECISION } from './types.js';

import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';

/**
 * The rule the backtest actually chose.
 *
 * Two ideas welded together, and it is worth being precise about which of them
 * is carrying the result, because an ablation of this exact rule on the exact
 * same data said the second one is doing almost all of the work:
 *
 *   - a twenty-bar breakout says *when to enter*;
 *   - a volatility test says *whether that entry counts*.
 *
 * Measured over 2018—2026 on daily BTCUSDT with costs: the full rule makes
 * 23.96%, and the volatility test on its own — long whenever the average true
 * range is above its own forty-bar mean, with no breakout at all — makes
 * 1354.60%. The breakout is not a contributor. It cuts exposure from 50% to
 * 13% and gives up most of the return.
 *
 * The breakout is kept anyway, and the reason is not that it helps. It is the
 * only part of the rule that is out of the market during a collapse: the gate
 * alone loses 11.63% in the worst year found by scanning the history, and the
 * full rule is positive in all four slices, while the stripped version is not.
 * Four trades is not evidence, so this is a reason to keep testing it, not a
 * reason to trust it.
 *
 * The honest summary of the whole rule is therefore: **be long about half the
 * time, filtered by volatility, with a breakout bolted on that costs two thirds
 * of the return and buys a bear-market behaviour nobody has yet seen often
 * enough to believe.** That sentence is the one to carry to the next held-out
 * period.
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
            const { candles } = context;

            if (candles.length < warmup) {
                return NEUTRAL_DECISION(
                    `Недостаточно истории: нужно ${warmup} баров, есть ${candles.length}`,
                    true,
                );
            }

            const highs = candles.map((candle) => candle.high);
            const lows = candles.map((candle) => candle.low);
            const last = candles[candles.length - 1]!;

            const channelHigh = latest(
                priorRolling(highs, config.channelPeriod, 'max'),
            );
            const channelLow = latest(priorRolling(lows, config.channelPeriod, 'min'));
            const atr = latest(atrSeries(candles, config.atrPeriod));
            const atrBaseline = latest(
                smaSeries(atrSeries(candles, config.atrPeriod), config.atrBaselinePeriod),
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
                    confidence: breakoutConfidence(last.close, channelHigh, atr),
                    reason:
                        `Пробой максимума за ${config.channelPeriod} баров ` +
                        `при повышенной волатильности`,
                    warm: false,
                };
            }

            if (last.close < channelLow) {
                return {
                    direction: 'SHORT',
                    confidence: breakoutConfidence(channelLow, last.close, atr),
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

/**
 * How far past the level the close sits, as a share of the bar's own range.
 *
 * A one-tick break and a break that clears the level by a third of the daily
 * range are not the same event, and publishing them at the same confidence
 * would tell a reader that the panel is equally sure about both. Capped, so a
 * gap cannot produce a number above certainty.
 */
function breakoutConfidence(
    distance: number,
    level: number,
    atr: number,
): number {
    if (!Number.isFinite(distance) || !Number.isFinite(level) || level <= 0) {
        return 0;
    }

    if (!Number.isFinite(atr) || atr <= 0) {
        return 0;
    }

    const width = Math.abs(distance - level);

    return Math.max(0, Math.min(0.95, width / (atr * 2)));
}
