import type { Candle } from '../types/market.js';

/**
 * The one implementation of the series the strategies are built from.
 *
 * This file exists because of a specific failure, not for tidiness. The
 * research bench and the running system must compute the same number from the
 * same candles, or the backtest describes a strategy nobody is trading. Two
 * copies of an indicator is the ordinary way that guarantee is lost: someone
 * smooths one of them differently, or fixes an edge case in one, and the
 * divergence is invisible until a live result stops matching the backtest that
 * justified it.
 *
 * There is already a second ATR in this codebase —
 * `indicators/atr.ts` — and it is **not** interchangeable. That one averages
 * the last *period* true ranges and reports a single latest reading; this one
 * is Wilder's smoothing over the whole series. The strategies were chosen
 * against the second. Swapping it for the first would quietly change every
 * number the backtest produced, and the change would be invisible in the
 * result and fatal in the comparison.
 *
 * Every function here is **causal by construction**: it fills index `i` from
 * index `i` and earlier and from nothing else. That is the property the
 * backtest's honesty rests on, and it is enforced by the shape of the code
 * rather than by remembering to be careful inside it.
 */

/** Latest value of the series, or NaN when it has not warmed up. */
export function latest(series: readonly number[]): number {
    return series[series.length - 1] ?? NaN;
}

export function isReady(...values: number[]): boolean {
    return values.every((value) => Number.isFinite(value));
}

/**
 * Rolling maximum over the `period` bars ending at each index, inclusive.
 */
export function rollingMax(values: readonly number[], period: number): number[] {
    const out = new Array<number>(values.length).fill(NaN);

    for (let index = 0; index < values.length; index += 1) {
        let best = -Infinity;

        for (let cursor = Math.max(0, index - period + 1); cursor <= index; cursor += 1) {
            best = Math.max(best, values[cursor]!);
        }

        out[index] = best;
    }

    return out;
}

/** Rolling minimum over the `period` bars ending at each index, inclusive. */
export function rollingMin(values: readonly number[], period: number): number[] {
    const out = new Array<number>(values.length).fill(NaN);

    for (let index = 0; index < values.length; index += 1) {
        let best = Infinity;

        for (let cursor = Math.max(0, index - period + 1); cursor <= index; cursor += 1) {
            best = Math.min(best, values[cursor]!);
        }

        out[index] = best;
    }

    return out;
}

/**
 * The rolling high or low of the *previous* `period` bars, excluding the
 * current one.
 *
 * This is the series a breakout has to be measured against, and the exclusion
 * is the entire rule. Comparing a close to a window that contains it means
 * every bar is trivially inside its own channel and no breakout can ever
 * fire; comparing it to a window that includes the current high lets a bar
 * clear a level using its own extreme, which is the definition of the thing
 * being measured. The first version of the bench used the inclusive window
 * and produced a channel that could not trigger.
 */
export function priorRolling(
    values: readonly number[],
    period: number,
    pick: 'max' | 'min',
): number[] {
    const inner = pick === 'max' ? rollingMax(values, period) : rollingMin(values, period);
    const out = new Array<number>(values.length).fill(NaN);

    for (let index = 1; index < values.length; index += 1) {
        out[index] = inner[index - 1]!;
    }

    return out;
}

/**
 * Simple moving average, tolerant of a leading undefined region.
 *
 * A plain running sum takes the first NaN and stays NaN for every later index,
 * because NaN plus anything is NaN. Chained behind an indicator with a longer
 * warmup — the average of an average true range — that produces a series
 * undefined everywhere, silently, and any rule gated on it simply never fires.
 * A rule that never trades reports a flat line, which reads as a result rather
 * than as a bug.
 */
export function smaSeries(values: readonly number[], period: number): number[] {
    const out = new Array<number>(values.length).fill(NaN);
    const window: number[] = [];

    for (let index = 0; index < values.length; index += 1) {
        const value = values[index]!;

        if (!Number.isFinite(value)) {
            continue;
        }

        window.push(value);

        if (window.length > period) {
            window.shift();
        }

        if (window.length === period) {
            let sum = 0;

            for (const item of window) {
                sum += item;
            }

            out[index] = sum / period;
        }
    }

    return out;
}

/**
 * Exponential moving average, seeded with a simple average of the first
 * `period` values.
 */
export function emaSeries(values: readonly number[], period: number): number[] {
    const out = new Array<number>(values.length).fill(NaN);

    if (values.length < period) {
        return out;
    }

    const multiplier = 2 / (period + 1);
    let ema = 0;

    for (let index = 0; index < period; index += 1) {
        ema += values[index]!;
    }

    ema /= period;
    out[period - 1] = ema;

    for (let index = period; index < values.length; index += 1) {
        ema = values[index]! * multiplier + ema * (1 - multiplier);
        out[index] = ema;
    }

    return out;
}

/**
 * Relative Strength Index, Wilder's smoothing, seeded with a simple average of
 * the first `period` changes.
 */
export function rsiSeries(closes: readonly number[], period: number): number[] {
    const out = new Array<number>(closes.length).fill(NaN);

    if (closes.length <= period) {
        return out;
    }

    let gain = 0;
    let loss = 0;

    for (let index = 1; index <= period; index += 1) {
        const change = closes[index]! - closes[index - 1]!;
        gain += Math.max(0, change);
        loss += Math.max(0, -change);
    }

    let averageGain = gain / period;
    let averageLoss = loss / period;
    out[period] = rsiValue(averageGain, averageLoss);

    for (let index = period + 1; index < closes.length; index += 1) {
        const change = closes[index]! - closes[index - 1]!;
        averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
        averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
        out[index] = rsiValue(averageGain, averageLoss);
    }

    return out;
}

function rsiValue(averageGain: number, averageLoss: number): number {
    return averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
}

/**
 * Wilder's smoothed average true range, in the same units as price.
 *
 * The first candle has no previous close and so contributes no true range.
 * Starting the loop at one rather than zero is not a detail: including it
 * would make the first reading a function of where the sample happens to
 * begin, which differs between the backtest window and the live window and
 * therefore between a strategy's backtested behaviour and its actual one.
 */
export function atrSeries(candles: readonly Candle[], period: number): number[] {
    const out = new Array<number>(candles.length).fill(NaN);

    if (candles.length <= period) {
        return out;
    }

    const trueRange = candles.map((candle, index) => {
        if (index === 0) {
            return candle.high - candle.low;
        }

        const previous = candles[index - 1]!.close;

        return Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - previous),
            Math.abs(candle.low - previous),
        );
    });

    let value = 0;

    for (let index = 0; index < period; index += 1) {
        value += trueRange[index]!;
    }

    value /= period;
    out[period - 1] = value;

    for (let index = period; index < trueRange.length; index += 1) {
        value = (value * (period - 1) + trueRange[index]!) / period;
        out[index] = value;
    }

    return out;
}
