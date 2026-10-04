import { atrSeries, breakoutStrength, isReady, latest, smaSeries } from './series.js';
import type { StrategyContext, StrategyDecision, StrategyModule } from './types.js';
import { NEUTRAL_DECISION } from './types.js';

/**
 * No breakout. Just be long while the market is moving more than it usually does.
 *
 * This is variant D from the ablation, and it was the worst thing in the
 * project until the fixture was found to be the wrong instrument. On Binance
 * BTCUSDT, 2096 daily bars from 2021-01-01, with the same costs and the same
 * fills as everything else measured here:
 *
 *   D. volatility filter alone      +222.99%   PF 1.994   67 trades
 *   B. twenty-bar breakout alone    +15.14%    PF 1.150  140 trades
 *   A. breakout with the filter       +9.28%    PF 1.164   74 trades
 *   E. a fixed schedule, no logic    -51.05%    PF 0.798  254 trades
 *
 * Half the trades and eleven times the return of the rule built on top of it.
 * Every piece of channel logic in the other modules is not adding to this — it
 * is standing between it and the money.
 *
 * **What this is not.** It is a hypothesis found by taking a rule apart and
 * looking at which piece was carrying it, which is the least safe way there is
 * to find a rule. The whole apparatus in `holdout.ts` exists because findings
 * like this one are usually noise wearing a mechanism, and four numbers on one
 * series cannot tell the difference. So this is registered for the held-out
 * window and is not installed: the default fallback remains the rule the user
 * asked for by name, which is still the right default precisely because it is
 * not this one.
 *
 * It is also not a claim that volatility predicts anything. It may simply be
 * that BTC in 2021—2026 spent a lot of its time rising and a filter that was
 * long most of the time was long for most of that. Line E is the control for
 * that and it lost 51%, which argues the filter is doing something — but argues
 * it, and does not prove it.
 */

export interface VolatilityTrendConfig {
    /** ATR period. */
    readonly atrPeriod: number;
    /** Bars averaged to make the volatility benchmark. */
    readonly baselinePeriod: number;
}

export const VOLATILITY_TREND_CONFIG: VolatilityTrendConfig = {
    atrPeriod: 14,
    baselinePeriod: 40,
};

export function createVolatilityTrend(
    config: VolatilityTrendConfig = VOLATILITY_TREND_CONFIG,
): StrategyModule {
    const warmup = config.atrPeriod + config.baselinePeriod + 1;

    return {
        key: 'volatility-trend',
        name: `Лонг при волатильности выше средней (${config.atrPeriod}/${config.baselinePeriod})`,
        mechanism:
            'A single test, with no level and no channel: while the market is ' +
            'moving more than it has been moving on average over the last ' +
            `${config.baselinePeriod} bars, be long, and otherwise stand aside. ` +
            'The reading is that expansion in realised volatility marks a ' +
            'regime that has continued rather than one that has ended, and the ' +
            'claim is deliberately small — that this is a better description of ' +
            'what happened than a twenty-bar channel is. Mechanism: volatility ' +
            'regime, and nothing else. Found by ablating a rule that contained ' +
            'it, not proposed before one.',
        warmup,

        evaluate(context: StrategyContext): StrategyDecision {
            const { candles } = context;

            if (candles.length < warmup) {
                return NEUTRAL_DECISION(
                    `Недостаточно истории: нужно ${warmup} баров, есть ${candles.length}`,
                    true,
                );
            }

            const atr = latest(atrSeries(candles, config.atrPeriod));
            const baseline = latest(
                smaSeries(
                    atrSeries(candles, config.atrPeriod),
                    config.baselinePeriod,
                ),
            );

            if (!isReady(atr, baseline)) {
                return NEUTRAL_DECISION(
                    'Индикаторы правила ещё не прогрелись',
                    true,
                );
            }

            if (atr <= baseline) {
                return NEUTRAL_DECISION(
                    'Волатильность не выше своей средней — правило ждёт',
                );
            }

            // Confidence is the distance past the line, on the same measured
            // basis as every other module, and capped below one. There is no
            // channel here, so the ATR itself is the scale.
            return {
                direction: 'LONG',
                confidence: breakoutStrength(atr, baseline, atr),
                reason:
                    `Волатильность выше средней за ${config.baselinePeriod} баров`,
                warm: false,
            };
        },
    };
}
