import { calculateMarketIndicators } from '../indicators/indicator.service.js';
import { calculateSignal } from '../signals/signal.service.js';
import { INDICATOR_SIGNAL_CONFIG } from '../config/indicator.config.js';

import type { MarketIndicators } from '../indicators/indicator.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import type { Candle, MarketData } from '../types/market.js';
import type { IndicatorSignalOverrides } from '../config/indicator.config.js';

export interface PointInTimeSignal {
    index: number;
    /** Close of the last candle the signal was allowed to see. */
    price: number;
    /** Closes the EMA vote was allowed to see, newest last. */
    recentCloses: number[];
    indicators: MarketIndicators;
    signal: SignalResult;
}

function signalFrom(
    point: Omit<PointInTimeSignal, 'signal'>,
    overrides?: IndicatorSignalOverrides,
): PointInTimeSignal {
    return {
        ...point,
        signal: calculateSignal(
            point.price,
            point.indicators,
            point.recentCloses,
            overrides,
        ),
    };
}

/**
 * The signal as it stood at the close of candle `index`.
 *
 * Only candles up to and including `index` are passed to the indicator
 * pipeline. Passing the whole series and asking for "the value at index i"
 * would be the single easiest way to build a backtest that looks brilliant
 * and means nothing: an EMA or a stochastic computed over the full series
 * carries information from the future back into the past, and every metric
 * derived from it is fiction.
 */
export function computeSignalAt(
    candles: Candle[],
    index: number,
    overrides?: IndicatorSignalOverrides,
): PointInTimeSignal | null {
    const visible = candles.slice(0, index + 1);

    if (visible.length < 2) {
        return null;
    }

    const price = visible[visible.length - 1]!.close;

    const marketData: MarketData = {
        price: { symbol: 'BACKTEST', price },
        candles: visible,
    };

    return signalFrom(
        {
            index,
            price,
            recentCloses: visible
                .slice(-(INDICATOR_SIGNAL_CONFIG.ema.confirmBars + 1))
                .map((candle) => candle.close),
            indicators: calculateMarketIndicators(marketData),
        },
        overrides,
    );
}

/**
 * The same signals for a whole range, computed once.
 *
 * Fitting parameters over a grid would otherwise recompute an EMA and a
 * stochastic for every combination, even though the indicators do not depend
 * on the thresholds at all — only the last step does. Separating the two
 * turns an intractable search into a cheap re-thresholding of cached values.
 */
export function computeSignalSeries(
    candles: Candle[],
    startIndex: number,
    endIndex: number,
): PointInTimeSignal[] {
    const points: PointInTimeSignal[] = [];

    for (let index = startIndex; index <= endIndex; index += 1) {
        const point = computeSignalAt(candles, index);

        if (point !== null) {
            points.push(point);
        }
    }

    return points;
}

export function reapplyThresholds(
    points: PointInTimeSignal[],
    overrides?: IndicatorSignalOverrides,
): PointInTimeSignal[] {
    if (overrides === undefined) {
        return points;
    }

    return points.map((point) => signalFrom(point, overrides));
}
