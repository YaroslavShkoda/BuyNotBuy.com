import type { IndicatorSignalOverrides } from '../config/indicator.config.js';
import { INDICATOR_SIGNAL_CONFIG } from '../config/indicator.config.js';
import { marketConfig } from '../config/market.config.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import { calculateMarketIndicators } from '../indicators/indicator.service.js';
import { calculateSignal } from '../signals/signal.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import type { Candle, MarketData } from '../types/market.js';

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

    // The envelope is filled in rather than left half-built, and the timestamp
    // is the close of the last visible bar — not the wall clock. A point-in-time
    // helper whose own record claimed to be from "now" would smuggle the very
    // thing it exists to prevent into everything downstream that reads it.
    const marketData: MarketData = {
        price: { symbol: 'BACKTEST', price },
        candles: visible,
        provider: 'backtest',
        symbol: 'BACKTEST',
        interval: marketConfig.candleInterval,
        timestamp: visible[visible.length - 1]!.timestamp,
    };

    return signalFrom(
        {
            index,
            price,
            // Sliced with the *override's* confirm window, not the shipped one.
            // The overrides are applied to the signal a few lines below, so a
            // market configured to need five confirmations would have been given
            // the four closes the global setting asks for and then required
            // five — a rule that could never fire, on one market only, which is
            // the hardest kind of this to notice: every other market is fine.
            recentCloses: visible
                .slice(
                    -((overrides?.ema?.confirmBars ?? INDICATOR_SIGNAL_CONFIG.ema.confirmBars) + 1),
                )
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
