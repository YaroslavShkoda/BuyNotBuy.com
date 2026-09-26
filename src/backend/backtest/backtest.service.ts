import { getMarketData } from '../market/market.service.js';
import { marketDataProvider } from '../market/market.provider.js';
import { marketConfig } from '../config/market.config.js';
import { INDICATOR_SIGNAL_CONFIG, requiredCandleCount } from '../config/indicator.config.js';
import { assertCandleSeries } from '../market/candle-validation.js';

import { runWalkForward, DEFAULT_WALK_FORWARD_OPTIONS } from './walk-forward.js';

import type { WalkForwardOptions, WalkForwardResult } from './walk-forward.js';

export interface BacktestReport extends WalkForwardResult {
    symbol: string;
    candleInterval: string;
    /** Candles the report was computed from. */
    candleCount: number;
    /** First and last bar of the sample, so the report states its period. */
    from: number;
    to: number;
    /** The live snapshot, kept so the report can name the current price. */
    currentPrice: number;
    dataStale: boolean;
    dataAgeMs: number;
    /** How many bars were fetched to fill the warm-up plus the windows. */
    requestedCandles: number;
    shippedParameters: {
        longThreshold: number;
        shortThreshold: number;
    };
    options: WalkForwardOptions;
}

function requiredCandles(options: WalkForwardOptions): number {
    return (
        requiredCandleCount() +
        options.trainingBars +
        options.foldBars * options.maxFolds
    );
}

/**
 * Runs a walk-forward over real history.
 *
 * The live snapshot is sized for the indicator warm-up, which is all the
 * dashboard needs but leaves a backtest with nothing to evaluate: every bar
 * would be spent warming up. History is therefore fetched separately, sized
 * to the warm-up plus the training and evaluation windows, and the live
 * snapshot is read only to name the current price.
 */
export async function runBacktest(
    options: Partial<WalkForwardOptions> = {},
): Promise<BacktestReport> {
    const resolved = { ...DEFAULT_WALK_FORWARD_OPTIONS, ...options };
    const needed = requiredCandles(resolved);

    const snapshot = await getMarketData();

    const candles = await marketDataProvider.getHistoricalCandles(needed);

    // The same integrity checks the live path applies, so a backtest cannot
    // quietly measure a series the live service would have rejected. The cap
    // is raised because a multi-page history is larger than any single
    // response the provider is allowed to return.
    assertCandleSeries(
        candles,
        Date.now(),
        marketConfig.provider,
        needed + 1,
    );

    const result = runWalkForward(candles, resolved);

    return {
        ...result,
        symbol: marketConfig.symbol,
        candleInterval: marketConfig.candleInterval,
        candleCount: candles.length,
        from: candles[0]?.timestamp ?? 0,
        to: candles[candles.length - 1]?.timestamp ?? 0,
        currentPrice: snapshot.data.price.price,
        dataStale: snapshot.stale,
        dataAgeMs: snapshot.ageMs,
        requestedCandles: needed,
        shippedParameters: {
            longThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
            shortThreshold: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
        },
        options: resolved,
    };
}
