import { indicatorConfig } from '../config/indicator.config.js';
import { regimeConfig } from '../config/regime.config.js';
import { calculateATR } from './atr.js';
import { calculateADX } from './adx.js';
import { calculateBollingerBands } from './bollinger.js';

import type { Candle } from '../types/market.js';

/**
 * What kind of market this is right now.
 *
 * A regime is the one label a signal can be judged against after the fact.
 * "LONG" means something very different in a quiet range than it does in a
 * volatility spike, and without the label the only way to find out is to go
 * and look at the chart for a hundred signals that have already been given.
 * Every performance statistic computed later — the one that matters is per
 * regime — starts from this.
 *
 * The design commitment is that it is computed, not inferred. Nothing here
 * reads a price and guesses; the regime is a function of named indicator
 * values, every threshold is configuration, and the whole answer is reported
 * with the numbers it came from so a wrong one can be traced to the input
 * that was wrong rather than to the label.
 */

export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export type TrendRegime =
    | 'TREND_UP'
    | 'TREND_DOWN'
    | 'RANGE'
    | 'HIGH_VOL'
    | 'LOW_VOL';

export interface RegimeInput {
    readonly candles: readonly Candle[];
}

export interface RegimeReading {
    /** How volatile the market is against its own recent history. */
    readonly volatility: VolatilityRegime;
    /** What is happening, where the volatility label may take precedence. */
    readonly trend: TrendRegime;
    /** The ATR used, as a fraction of price. */
    readonly atr: number;
    /**
     * Typical range over the recent window, divided by the instrument's own
     * median. Reported rather than only being used to pick a label, because
     * "HIGH" is a claim and the ratio is the evidence for it.
     */
    readonly volatilityRatio: number;
    readonly adx: number;
    readonly plusDI: number;
    readonly minusDI: number;
    /** Bollinger bandwidth, as a second read on the same question. */
    readonly bandwidth: number;
    /** Bars the baseline was measured over, and bars actually available. */
    readonly baselineBars: number;
    /**
     * Why the answer may not be trusted, when it may not be.
     *
     * `null` when the reading stands. Anything else names the reason in terms
     * somebody can act on — too few bars, a flat market with no baseline —
     * rather than returning a confident number built on nothing.
     */
    readonly unreliable: string | null;
}

export function assessRegime(input: RegimeInput): RegimeReading {
    const { candles } = input;
    const atr = calculateATR(
        [...candles],
        indicatorConfig.atrPeriod,
    );
    const bands = calculateBollingerBands(
        [...candles],
        indicatorConfig.bollingerPeriod,
        indicatorConfig.bollingerStdDev,
    );
    const movement = calculateADX([...candles], indicatorConfig.adxPeriod);

    const baseline = volatilityBaseline(candles);
    const current = typicalRange(candles, indicatorConfig.atrPeriod);
    const ratio = baseline <= 0 ? Number.NaN : current / baseline;

    const volatility = volatilityFrom(ratio);
    const trend = trendFrom({
        adx: movement.adx,
        plusDI: movement.plusDI,
        minusDI: movement.minusDI,
        volatility,
    });

    return {
        volatility,
        trend,
        atr,
        volatilityRatio: ratio,
        adx: movement.adx,
        plusDI: movement.plusDI,
        minusDI: movement.minusDI,
        bandwidth: bands.bandwidth,
        baselineBars: Math.min(candles.length, regimeConfig.baselineBars),
        unreliable: whyUnreliable(candles, baseline, ratio),
    };
}

/**
 * The instrument's own median ATR over the baseline window.
 *
 * A median rather than a mean, and that is the whole reason the ratio is
 * usable. One violent afternoon raises a mean enough to make the afternoon
 * itself look like the new normal, and a baseline that moves with the thing it
 * is supposed to measure cannot detect anything. The median needs half the
 * window to move before it moves at all.
 */
function volatilityBaseline(candles: readonly Candle[]): number {
    // The whole available history, not history minus the recent window. An
    // earlier version excluded the bars being measured, on the theory that a
    // baseline must not contain what it judges — but a median already answers
    // that, and a violent afternoon is a few bars out of hundreds, which moves
    // it not at all. Excluding the recent window only costs a third of the
    // history on a short series and makes the answer depend on an arbitrary
    // cut-off.
    return medianOf(typicalRangePerBar(candles.slice(-regimeConfig.baselineBars)));
}

/**
 * A median rather than a mean, over the most recent `bars` values.
 *
 * The current value has to be the same kind of statistic as the baseline it is
 * divided by. `calculateATR` is a mean, and dividing a mean by a median
 * compares two different questions: on a market where the range shrinks as a
 * fraction of price — every rising market — the window average is dragged down
 * by the wide, cheap bars at the far end, and the ratio reads LOW for a market
 * that is travelling exactly as far as it always has. Both sides are medians so
 * that the ratio is about the same quantity.
 */
function typicalRange(candles: readonly Candle[], bars: number): number {
    return medianOf(typicalRangePerBar(candles.slice(-(bars + 1))));
}

function typicalRangePerBar(candles: readonly Candle[]): number[] {
    return candles
        .slice(1)
        .map((candle, index) => {
            const previous = candles[index];

            if (previous === undefined || candle.close <= 0) {
                return Number.NaN;
            }

            return (
                Math.max(
                    candle.high - candle.low,
                    Math.abs(candle.high - previous.close),
                    Math.abs(candle.low - previous.close),
                ) / candle.close
            );
        })
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
}

function medianOf(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const middle = Math.floor(values.length / 2);

    return values.length % 2 === 0
        ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2
        : (values[middle] ?? 0);
}

function volatilityFrom(ratio: number): VolatilityRegime {
    if (!Number.isFinite(ratio)) {
        // No baseline to compare against. Claiming NORMAL would be claiming
        // something about a market measured against nothing.
        return 'NORMAL';
    }

    if (ratio >= regimeConfig.volatility.extreme) {
        return 'EXTREME';
    }

    if (ratio >= regimeConfig.volatility.high) {
        return 'HIGH';
    }

    if (ratio < regimeConfig.volatility.normal) {
        return 'LOW';
    }

    return 'NORMAL';
}

function trendFrom(reading: {
    adx: number;
    plusDI: number;
    minusDI: number;
    volatility: VolatilityRegime;
}): TrendRegime {
    // Volatility first, and deliberately. A strong directional move inside an
    // extreme volatility spike is mostly a statement about how far apart
    // consecutive prices are, not about a trend anybody should follow, and
    // calling it TREND_UP is how a flash crash reads as a buy.
    if (reading.volatility === 'EXTREME') {
        return 'HIGH_VOL';
    }

    if (reading.adx < regimeConfig.trend.weak) {
        return reading.volatility === 'LOW' ? 'LOW_VOL' : 'RANGE';
    }

    const dominant = Math.max(reading.plusDI, reading.minusDI);

    // A trend with no side to it. +DI 55 against -DI 45 is a real trend and a
    // real "do not know which way", and TREND_UP would be a coin flip with a
    // confident name on it.
    if (dominant < regimeConfig.directional) {
        return 'RANGE';
    }

    return reading.plusDI > reading.minusDI ? 'TREND_UP' : 'TREND_DOWN';
}

/**
 * Why this reading may not be trusted, in words somebody can act on.
 *
 * A regime is the context every later statistic is grouped by, so a wrong one
 * does not just mislabel a chart — it splits a performance table into groups
 * that were never different. Saying so is more useful than a number.
 */
function whyUnreliable(
    candles: readonly Candle[],
    baseline: number,
    ratio: number,
): string | null {
    if (candles.length < regimeConfig.minimumBars) {
        return `fewer than ${regimeConfig.minimumBars} bars`;
    }

    if (baseline <= 0) {
        return 'no volatility baseline: the market has not moved';
    }

    if (!Number.isFinite(ratio)) {
        return 'no volatility ratio';
    }

    return null;
}
