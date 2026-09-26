import { indicatorConfig, requiredCandleCount } from '../config/indicator.config.js';
import { MarketDataError } from '../errors/market-data.error.js';

import type { MarketData } from '../types/market.js';

import { calculateEMA } from './ema.js';
import { calculateStochastic } from './stochastic.js';
import { calculateMomentum } from './momentum.js';
import { calculateATR } from './atr.js';
import { calculateRSI } from './rsi.js';
import { calculateMACD } from './macd.js';

export interface MarketIndicators {
    ema300: number;
    stochastic: number;
    momentum: number;
    /**
     * Context, not a vote.
     *
     * These three describe the market rather than taking a side in it, and
     * they are deliberately kept out of the consensus. RSI correlates closely
     * with the stochastic and MACD with the EMA, so three more voters would
     * look like three more confirmations while adding no independent evidence
     * — and the agreement figure would rise without the signal getting any
     * stronger. Adding one to the vote is a change to the signal, not to the
     * display, and it is a change to be made on evidence.
     */
    atr: number;
    rsi: number;
    macd: {
        macd: number;
        signal: number;
        histogram: number;
    };
}

export function calculateMarketIndicators(
    marketData: MarketData,
): MarketIndicators {
    const closePrices = marketData.candles.map(
        (candle) => candle.close,
    );

    assertWarmupCandles(closePrices.length);

    const ema300 = calculateEMA(
        closePrices,
        indicatorConfig.emaPeriod,
    );

    const stochastic = calculateStochastic(
        marketData.candles,
        indicatorConfig.stochasticPeriod,
    );

    const momentum = calculateMomentum(
        marketData.candles,
        indicatorConfig.momentumPeriod,
    );

    const atr = calculateATR(
        marketData.candles,
        indicatorConfig.atrPeriod,
    );

    const rsi = calculateRSI(
        marketData.candles,
        indicatorConfig.rsiPeriod,
    );

    const macd = calculateMACD(
        closePrices,
        indicatorConfig.macdFastPeriod,
        indicatorConfig.macdSlowPeriod,
        indicatorConfig.macdSignalPeriod,
    );

    return {
        ema300,
        stochastic,
        momentum,
        atr,
        rsi,
        macd,
    };
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
