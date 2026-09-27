import { indicatorConfig, requiredCandleCount } from '../config/indicator.config.js';
import { MarketDataError } from '../errors/market-data.error.js';
import { calculateATR } from './atr.js';
import { calculateEMA } from './ema.js';
import { calculateMACD } from './macd.js';
import { calculateMomentum } from './momentum.js';
import { calculateRSI } from './rsi.js';
import { calculateStochastic } from './stochastic.js';
import { createIndicatorRegistry, indicatorContext } from './indicator.registry.js';

import type { IndicatorDefinition, IndicatorRegistry, IndicatorValue } from './indicator.registry.js';
import type { MarketData } from '../types/market.js';

/**
 * Everything this system knows how to compute, in one list.
 *
 * The list is the point. Before this, an indicator was seven edits — a function,
 * an interface, an API schema, a signal key, a switch, a performance table and
 * a dashboard row — and missing any one of them produced no error. An
 * indicator that computes, never reaches a vote, and is never displayed is a
 * thing that has shipped. Here it is a definition and a registration, and the
 * role it declares is the only thing that decides whether it votes.
 */

/**
 * The internal name is `ema`, not `ema300`.
 *
 * The period is a configured value that happens to be 300, and a field named
 * after it is a field that lies the moment somebody sets INDICATOR_EMA_PERIOD.
 * The wire format keeps `ema300` — see `toWireIndicators` — because the
 * published contract is not ours to rename, and a client that starts receiving
 * `undefined` has to be the last thing that happens here.
 */
export const EMA_INDICATOR: IndicatorDefinition = {
    key: 'ema',
    name: `EMA ${indicatorConfig.emaPeriod}`,
    role: 'vote',
    // Three periods of recursion, so the SMA seed is washed out. With a
    // one-period warm-up "EMA 300" is arithmetically SMA-300, which tracks the
    // window rather than price and looks like a working indicator.
    warmup: indicatorConfig.emaPeriod * indicatorConfig.emaWarmupMultiplier,
    calculate: (context) => ({
        value: calculateEMA(context.closes, indicatorConfig.emaPeriod),
    }),
};

export const STOCHASTIC_INDICATOR: IndicatorDefinition = {
    key: 'stochastic',
    name: `Stochastic ${indicatorConfig.stochasticPeriod}`,
    role: 'vote',
    warmup: indicatorConfig.stochasticPeriod,
    calculate: (context) => ({
        value: calculateStochastic(
            context.candles,
            indicatorConfig.stochasticPeriod,
        ),
    }),
};

export const MOMENTUM_INDICATOR: IndicatorDefinition = {
    key: 'momentum',
    name: `Momentum ${indicatorConfig.momentumPeriod}`,
    role: 'vote',
    warmup: indicatorConfig.momentumPeriod + 1,
    calculate: (context) => ({
        value: calculateMomentum(
            context.candles,
            indicatorConfig.momentumPeriod,
        ),
    }),
};

/**
 * Context, not a vote — and that is a decision the role now records rather
 * than something each call site has to remember.
 *
 * RSI correlates closely with the stochastic and MACD with the EMA, so three
 * more voters would look like three more confirmations while adding no
 * independent evidence: the agreement figure would rise without the signal
 * getting any stronger. Adding one to the vote is a change to the signal, not
 * to the display, and it is a change to be made on evidence.
 */
export const ATR_INDICATOR: IndicatorDefinition = {
    key: 'atr',
    name: `ATR ${indicatorConfig.atrPeriod}`,
    role: 'context',
    warmup: indicatorConfig.atrPeriod + 1,
    calculate: (context) => ({
        value: calculateATR(context.candles, indicatorConfig.atrPeriod),
    }),
};

export const RSI_INDICATOR: IndicatorDefinition = {
    key: 'rsi',
    name: `RSI ${indicatorConfig.rsiPeriod}`,
    role: 'context',
    warmup: indicatorConfig.rsiPeriod + 1,
    calculate: (context) => ({
        value: calculateRSI(context.candles, indicatorConfig.rsiPeriod),
    }),
};

export const MACD_INDICATOR: IndicatorDefinition = {
    key: 'macd',
    name: `MACD ${indicatorConfig.macdFastPeriod}/${indicatorConfig.macdSlowPeriod}/${indicatorConfig.macdSignalPeriod}`,
    role: 'context',
    warmup:
        indicatorConfig.macdSlowPeriod + indicatorConfig.macdSignalPeriod,
    calculate: (context) => {
        const result = calculateMACD(
            context.closes,
            indicatorConfig.macdFastPeriod,
            indicatorConfig.macdSlowPeriod,
            indicatorConfig.macdSignalPeriod,
        );

        return {
            value: result.macd,
            extra: {
                signal: result.signal,
                histogram: result.histogram,
            },
        };
    },
};

/**
 * The registry the process runs on.
 *
 * Module scope on purpose: it is the answer to "what does this system compute",
 * and a fresh one per request would make that question have as many answers as
 * there are requests.
 */
export const indicatorRegistry: IndicatorRegistry = (() => {
    const registry = createIndicatorRegistry();

    for (const definition of [
        EMA_INDICATOR,
        STOCHASTIC_INDICATOR,
        MOMENTUM_INDICATOR,
        ATR_INDICATOR,
        RSI_INDICATOR,
        MACD_INDICATOR,
    ]) {
        registry.register(definition);
    }

    return registry;
})();

/**
 * The internal shape: `ema`, not `ema300`.
 *
 * Field names here are the ones the rest of the backend reasons about, and a
 * field named after a period is a field that lies the moment the period is
 * configured to something else.
 */
export interface MarketIndicators {
    ema: number;
    stochastic: number;
    momentum: number;
    atr: number;
    rsi: number;
    macd: {
        macd: number;
        signal: number;
        histogram: number;
    };
}

/** The published shape. `ema300` is the name the contract has always had. */
export interface MarketIndicatorsWire extends Omit<MarketIndicators, 'ema'> {
    ema300: number;
}

export function calculateMarketIndicators(
    marketData: MarketData,
): MarketIndicators {
    assertWarmupCandles(marketData.candles.length);

    const values = indicatorRegistry.calculate(
        indicatorContext(marketData.candles, marketData.timestamp),
    );

    const ema = requireValue(values, EMA_INDICATOR.key).value;
    const macd = requireValue(values, MACD_INDICATOR.key);

    return {
        ema,
        stochastic: requireValue(values, STOCHASTIC_INDICATOR.key).value,
        momentum: requireValue(values, MOMENTUM_INDICATOR.key).value,
        atr: requireValue(values, ATR_INDICATOR.key).value,
        rsi: requireValue(values, RSI_INDICATOR.key).value,
        macd: {
            macd: macd.value,
            signal: macd.extra?.signal ?? Number.NaN,
            histogram: macd.extra?.histogram ?? Number.NaN,
        },
    };
}

/**
 * The wire shape, for the response.
 *
 * The rename stops at the boundary. A client that has been reading `ema300`
 * since the first release does not learn about this refactor by receiving
 * `undefined`, and the dashboard is not ours to break on the way past.
 */
export function toWireIndicators(indicators: MarketIndicators): MarketIndicatorsWire {
    return {
        ema300: indicators.ema,
        stochastic: indicators.stochastic,
        momentum: indicators.momentum,
        atr: indicators.atr,
        rsi: indicators.rsi,
        macd: indicators.macd,
    };
}

/**
 * A registered indicator that produced nothing is an error, not a zero.
 *
 * The registry skips an indicator that cannot produce a value so the hole is
 * visible to every caller. This is the one place that refuses to continue: a
 * missing value inside a batch is a hole, but a missing value in the published
 * set is an API that would answer with a number nobody computed.
 */
function requireValue(
    values: Readonly<Record<string, IndicatorValue>>,
    key: string,
): IndicatorValue {
    const found = values[key];

    if (found === undefined) {
        throw new MarketDataError('Indicator produced no value', {
            code: 'MARKET_INSUFFICIENT_HISTORY',
            cause: { indicator: key, candles: requiredCandleCount() },
        });
    }

    return found;
}

/**
 * Guard against a silently degraded EMA: with fewer candles than the warm-up
 * needs, the recursion loop never runs and the result collapses into the seed
 * SMA. That would look like a working indicator while measuring the window,
 * so the pipeline fails loudly instead.
 */
function assertWarmupCandles(candleCount: number): void {
    const required = requiredCandleCount();

    if (candleCount < required) {
        throw new MarketDataError(
            'Not enough candles to warm up indicators',
            {
                code: 'MARKET_INSUFFICIENT_HISTORY',
                cause: {
                    candleCount,
                    requiredCandleCount: required,
                    emaPeriod: indicatorConfig.emaPeriod,
                },
            },
        );
    }
}
