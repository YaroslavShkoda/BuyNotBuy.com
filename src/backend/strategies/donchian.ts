import { isReady, latest, priorRolling } from './series.js';
import { NEUTRAL_DECISION } from './types.js';

import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';

/**
 * A bare breakout, with nothing built on top of it.
 *
 * This is the rule the corrected measurements put in the strongest position,
 * and it is here for a reason beyond being a second module: the whole point of
 * making strategies pluggable is that the next choice is cheap. The fallback
 * currently shipped is `donchian-trend-gated`, and the corrected backtest put
 * that rule at minus 13.31% while putting this one at plus 21.77% on the same
 * data. Swapping between them is a line in the catalogue, and that is the
 * whole argument for the arrangement.
 *
 * What it is: **be long above the highest high of the last twenty bars, short
 * below the lowest low, out of the market in between.** A level that took
 * twenty bars to set is evidence of something, and the exit is the far side of
 * the same channel, so a winner is held and a loser is cut at the same
 * distance rather than at whatever the mood was when the trade went wrong.
 *
 * The measured profile, and it is worth knowing both halves: on 2018—2026
 * daily BTCUSDT with costs it makes 21.77% against a buy and hold of 1229%,
 * which is to say it is not trying to be that. It is positive in the second
 * half of the sample, and in the worst year of the sample it makes minus
 * 0.34% with an 11.76% drawdown. It is not a way to get rich. It is a way to
 * be in a trending market for 19% of the time and to lose almost nothing when
 * it is not.
 */
export interface DonchianConfig {
    readonly channelPeriod: number;
}

export const DONCHIAN_CONFIG: DonchianConfig = {
    channelPeriod: 20,
};

export function createDonchian(
    config: DonchianConfig = DONCHIAN_CONFIG,
): StrategyModule {
    const warmup = config.channelPeriod + 1;

    return {
        key: 'donchian-20',
        name: `Пробой ${config.channelPeriod}`,
        mechanism:
            'Trends persist, so a level that took twenty bars to set carries ' +
            'information a two-bar level does not. Price clearing it is ' +
            'evidence of demand, and the exit is the far side of the same ' +
            'channel, so a winner is held and a loser is cut at the same ' +
            'distance. Mechanism: long-horizon momentum.',
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

            // Excluding the current bar. Measured against a window that
            // contains it, every bar is trivially inside its own channel and
            // no breakout can ever fire.
            const channelHigh = latest(
                priorRolling(highs, config.channelPeriod, 'max'),
            );
            const channelLow = latest(priorRolling(lows, config.channelPeriod, 'min'));

            if (!isReady(channelHigh, channelLow)) {
                return NEUTRAL_DECISION('Канал ещё не прогрелся', true);
            }

            if (last.close > channelHigh) {
                return {
                    direction: 'LONG',
                    confidence: 0.6,
                    reason: `Пробой максимума за ${config.channelPeriod} баров`,
                    warm: false,
                };
            }

            if (last.close < channelLow) {
                return {
                    direction: 'SHORT',
                    confidence: 0.6,
                    reason: `Пробой минимума за ${config.channelPeriod} баров`,
                    warm: false,
                };
            }

            return NEUTRAL_DECISION('Цена внутри канала, направленного пробоя нет');
        },
    };
}
