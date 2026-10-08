import { indicatorConfig, requiredCandleCount } from '../config/indicator.config.js';
import { MarketDataError } from '../errors/market-data.error.js';
import { currentRegistry } from '../observability/registry.js';
import type { MarketIndicators, MarketIndicatorsWire } from '../types/analysis.js';
import type { Candle, MarketData } from '../types/market.js';
import { calculateADX } from './adx.js';
import { calculateATR } from './atr.js';
import { calculateBollingerBands } from './bollinger.js';
import type { IndicatorDefinition, IndicatorRegistry, IndicatorValue } from './indicator.registry.js';
import { createIndicatorRegistry, indicatorContext } from './indicator.registry.js';
import { calculateMACD } from './macd.js';
import { calculateMomentum } from './momentum.js';
import { calculateRSI } from './rsi.js';
import { createSeriesGraph, emaSeries } from './series.graph.js';
import { calculateStochastic } from './stochastic.js';

/**
 * The name the EMA series is resolved under, and the node itself.
 *
 * Built from the configured period, so a period change moves the node with it
 * and two processes on different settings cannot be sharing a cache entry that
 * means different things.
 */
export const emaSeriesKey = `ema:${indicatorConfig.emaPeriod}`;

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
    // Declared, not computed inline: the graph resolves it once for the whole
    // run, so an indicator added next month that also wants the EMA-300 gets
    // this one rather than paying for it again inside a request.
    series: [emaSeriesKey],
    calculate: (context) => {
        const fromGraph = context.series.get(emaSeriesKey);

        if (typeof fromGraph !== 'number') {
            throw new Error(
                `Indicator "ema" needs the series "${emaSeriesKey}" and it was not resolved`,
            );
        }

        return { value: fromGraph };
    },
};

const STOCHASTIC_INDICATOR: IndicatorDefinition = {
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

const MOMENTUM_INDICATOR: IndicatorDefinition = {
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
const ATR_INDICATOR: IndicatorDefinition = {
    key: 'atr',
    name: `ATR ${indicatorConfig.atrPeriod}`,
    role: 'context',
    warmup: indicatorConfig.atrPeriod + 1,
    calculate: (context) => ({
        value: calculateATR(context.candles, indicatorConfig.atrPeriod),
    }),
};

const RSI_INDICATOR: IndicatorDefinition = {
    key: 'rsi',
    name: `RSI ${indicatorConfig.rsiPeriod}`,
    role: 'context',
    warmup: indicatorConfig.rsiPeriod + 1,
    calculate: (context) => ({
        value: calculateRSI(context.candles, indicatorConfig.rsiPeriod),
    }),
};

const MACD_INDICATOR: IndicatorDefinition = {
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

const BOLLINGER_INDICATOR: IndicatorDefinition = {
    key: 'bollinger',
    name: `Bollinger ${indicatorConfig.bollingerPeriod}/${indicatorConfig.bollingerStdDev}`,
    role: 'context',
    warmup: indicatorConfig.bollingerPeriod,
    calculate: (context) => {
        const bands = calculateBollingerBands(
            context.candles,
            indicatorConfig.bollingerPeriod,
            indicatorConfig.bollingerStdDev,
        );

        // %B rather than the middle band, because the middle band is a
        // smoothed price and a caller asking for this wants to know where
        // price sits inside the range.
        return {
            value: bands.percentB,
            extra: {
                middle: bands.middle,
                upper: bands.upper,
                lower: bands.lower,
                bandwidth: bands.bandwidth,
            },
        };
    },
};

const ADX_INDICATOR: IndicatorDefinition = {
    key: 'adx',
    name: `ADX ${indicatorConfig.adxPeriod}`,
    role: 'context',
    // Wilder smooths the true range and then the directional index, so the
    // series has to be twice the period plus one bar long before the recursion
    // has anything to work with.
    warmup: indicatorConfig.adxPeriod * 2 + 1,
    calculate: (context) => {
        const movement = calculateADX(
            context.candles,
            indicatorConfig.adxPeriod,
        );

        // ADX itself, not +DI: the whole point of it is that it has no
        // direction, and a value that took a side would be a different
        // indicator wearing this one's name.
        return {
            value: movement.adx,
            extra: {
                plusDI: movement.plusDI,
                minusDI: movement.minusDI,
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
        BOLLINGER_INDICATOR,
        ADX_INDICATOR,
    ]) {
        registry.register(definition);
    }

    return registry;
})();

// `MarketIndicators` and the published `MarketIndicatorsWire` moved to
// `types/analysis.ts`, together: the wire shape is an `Omit` of the internal one
// with `ema` renamed, and a derivation that crosses a layer boundary has to be
// re-typed, which is exactly where a field could be dropped without the compiler
// objecting. Re-exported so this module's importers are unaffected, and so that
// arriving here still finds the name.
export type {
    MarketIndicators,
    MarketIndicatorsWire,
} from '../types/analysis.js';

/**
 * The graph the process runs on.
 *
 * Registered here rather than in the module that defines it, because the set
 * of series is a property of the indicator set — and an indicator set is the
 * thing this file owns.
 */
export const seriesGraph = (() => {
    const graph = createSeriesGraph();

    graph.register(emaSeries(indicatorConfig.emaPeriod));

    return graph;
})();

/**
 * Resolves everything the registered indicators declared they need.
 *
 * The union is taken from the registry rather than from a hand-written list,
 * which is the entire point: a list written here would be a list to forget to
 * update, and an indicator whose series silently resolved to nothing is
 * precisely the failure the graph is meant to make impossible.
 */
function resolveRequiredSeries(
    candles: readonly Candle[],
    closes: readonly number[],
): ReadonlyMap<string, unknown> {
    const required = indicatorRegistry
        .list()
        .flatMap((definition) => definition.series ?? []);

    if (required.length === 0) {
        return new Map();
    }

    return seriesGraph.resolve(required, { candles, closes }).values;
}

export function calculateMarketIndicators(
    marketData: MarketData,
): MarketIndicators {
    assertWarmupCandles(marketData.candles.length);

    const startedAt = performance.now();

    try {
        const context = indicatorContext(
            marketData.candles,
            marketData.timestamp,
        );
        const values = indicatorRegistry.calculate({
            ...context,
            series: resolveRequiredSeries(marketData.candles, context.closes),
        });

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
    } finally {
        // The whole window, not each indicator. The seven run over the same
        // 900 bars and the question worth answering is whether an analysis is
        // fast enough to be asked on a page load, not which of the seven is
        // the slow one — a per-indicator split here would be a label set
        // bounded by configuration and never queried.
        currentRegistry().observe(
            'indicator_calculation_duration',
            performance.now() - startedAt,
        );
    }
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
