import {
    atrSeries,
    breakoutStrength,
    isReady,
    latest,
    priorRolling,
    smaSeries,
} from './series.js';
import { NEUTRAL_DECISION } from './types.js';

import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';

/**
 * The gate, pointed the other way.
 *
 * This module exists because the ablation of `donchian-trend-gated` measured
 * that its volatility test runs backwards. Over the same 2018—2026 daily
 * history, with the same costs and the same fills:
 *
 *   breakout + high-volatility gate     -13.31%,  PF 0.965
 *   breakout, no gate                    +21.80%
 *   breakout + LOW volatility gate       +33.58%
 *   calendar, no logic                   -43.81%
 *
 * The fourth line matters: the bare breakout beats the calendar, so there is a
 * rule in here, and the third line says the gate as written removes it. A calm
 * drift to a new high reads as accumulation; a high-volatility break is more
 * often a spike that comes back.
 *
 * **What this is not.** It is not a better strategy. It is a hypothesis, formed
 * by looking at the result on the data that will be used to test it, and every
 * number above is in-sample. The price of writing it as a real module rather
 * than as a line in the ablation script is that it can be run on the held-out
 * window without anyone rebuilding it, and the cost is the temptation to treat
 * its name as a recommendation. It has never been traded, it has not been
 * through walk-forward on data it has not seen, and it is not installed in the
 * registry.
 *
 * Kept separate from `donchian-trend-gated` rather than parameterised by a
 * boolean, because the two are different claims about the world. A flag would
 * make them look like the same rule with a switch, and the switch is precisely
 * the thing that is in doubt.
 */

export interface DonchianCalmGatedConfig {
    /** Bars in the breakout channel. */
    readonly channelPeriod: number;
    /** ATR period. */
    readonly atrPeriod: number;
    /** Bars averaged to make the volatility benchmark. */
    readonly atrBaselinePeriod: number;
}

export const DONCHIAN_CALM_GATED_CONFIG: DonchianCalmGatedConfig = {
    channelPeriod: 20,
    atrPeriod: 14,
    atrBaselinePeriod: 40,
};

export function createDonchianCalmGated(
    config: DonchianCalmGatedConfig = DONCHIAN_CALM_GATED_CONFIG,
): StrategyModule {
    const warmup =
        Math.max(
            config.channelPeriod,
            config.atrPeriod + config.atrBaselinePeriod,
        ) + 1;

    return {
        key: 'donchian-calm-gated',
        name: `Пробой ${config.channelPeriod} в спокойном рынке`,
        mechanism:
            'A level that took twenty bars to set is worth more than one that ' +
            'took two, so a close beyond it is evidence of demand and the exit ' +
            'is the far side of the same channel. The volatility test is the ' +
            'part the ablation inverted: breakouts are taken only while the ' +
            'market is calmer than its own recent average, on the reading that ' +
            'a quiet drift to a new high is accumulation while a loud one is ' +
            'a spike that comes back. Mechanism: long-horizon momentum, ' +
            'restricted to the conditions it appears to work in. The ' +
            'restriction was derived from the result, not assumed before it.',
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
            const channelLow = latest(
                priorRolling(lows, config.channelPeriod, 'min'),
            );
            const atr = latest(atrSeries(candles, config.atrPeriod));
            const atrBaseline = latest(
                smaSeries(
                    atrSeries(candles, config.atrPeriod),
                    config.atrBaselinePeriod,
                ),
            );

            if (!isReady(channelHigh, channelLow, atr, atrBaseline)) {
                return NEUTRAL_DECISION(
                    'Индикаторы правила ещё не прогрелись',
                    true,
                );
            }

            // The inversion, and the whole content of this module. Inverted
            // relative to `donchian-trend-gated`, which waits for atr to exceed
            // its baseline and measures -13.31% while this one measures
            // +33.58% on the same bars.
            if (atr >= atrBaseline) {
                return NEUTRAL_DECISION(
                    'Волатильность выше своей средней — правило ждёт',
                );
            }

            if (last.close > channelHigh) {
                return {
                    direction: 'LONG',
                    confidence: breakoutStrength(last.close, channelHigh, atr),
                    reason:
                        `Пробой максимума за ${config.channelPeriod} баров ` +
                        `при спокойном рынке`,
                    warm: false,
                };
            }

            if (last.close < channelLow) {
                return {
                    direction: 'SHORT',
                    confidence: breakoutStrength(channelLow, last.close, atr),
                    reason:
                        `Пробой минимума за ${config.channelPeriod} баров ` +
                        `при спокойном рынке`,
                    warm: false,
                };
            }

            return NEUTRAL_DECISION(
                'Цена внутри канала, направленного пробоя нет',
            );
        },
    };
}
