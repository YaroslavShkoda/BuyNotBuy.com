import { donchianInputs } from './donchian.js';
import {
    atrSeries,
    breakoutStrength,
    isReady,
    latest,
    smaSeries,
} from './series.js';
import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';
import { NEUTRAL_DECISION } from './types.js';

/**
 * The gate, pointed the other way.
 *
 * **The premise this file was built on turned out to be an artifact.**
 *
 * It was written after the ablation of `donchian-trend-gated` measured that
 * its volatility test ran backwards, on the fixture then called
 * `btcusdt-1d.csv`:
 *
 *   breakout + high-volatility gate     -13.31%,  PF 0.965
 *   breakout, no gate                    +21.80%
 *   breakout + LOW volatility gate       +33.58%
 *   calendar, no logic                   -43.81%
 *
 * That fixture was later found to be Yahoo Finance's BTC-USD, and this system
 * trades Binance's BTCUSDT. On the right series, over 2096 daily bars from
 * 2021-01-01, the same ablation says:
 *
 *   A. breakout + high-volatility gate     +9.28%,  PF 1.164
 *   B. breakout, no gate                   +15.14%,  PF 1.150
 *   C. breakout + LOW volatility gate       +2.13%,  PF 1.087
 *
 * The gate is not running backwards. It was never running backwards. The
 * inverted version is *worse* than the original once both are measured on the
 * instrument the system trades, and every sentence of the original argument —
 * the calm drift, the accumulation, the spike that comes back — was a story
 * fitted to a data-source error.
 *
 * The module is kept rather than deleted for the same reason the old fixture
 * is kept: it is the evidence for how that mistake was made, and deleting it
 * would leave the next person to make it. It is registered as selectable and is
 * **not** the default. If it is ever used for anything, the first sentence above
 * is the thing to read.
 *
 * What the corrected ablation does support is a different and much simpler
 * claim, in `volatility-trend.ts`: that the volatility test is carrying the
 * rule and the channel is in the way of it.
 *
 * Kept separate from `donchian-trend-gated` rather than parameterised by a
 * boolean, because the two are different claims about the world. A flag would
 * make them look like one rule with a switch, and the switch is precisely the
 * thing that is in doubt.
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

            // The inversion. Measured once, on the wrong instrument, and
            // reported as a finding. On the right one it makes +2.13% against
            // the original's +9.28%, so the useful thing this line does now is
            // document that the direction was tested rather than assumed.
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
