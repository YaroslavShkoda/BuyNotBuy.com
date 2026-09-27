import type { Candle } from '../types/market.js';

/**
 * Hourly bars into daily ones, and the argument about what a day is.
 *
 * A daily candle is four numbers that can only be produced by a rule. The
 * open is the first hourly open of the day, the close is the last hourly
 * close, and the high and low are the extremes across the day. Everything
 * except those two is unambiguous — and those two are where a resampler and a
 * data provider will disagree, because a provider whose day boundary sits
 * somewhere else — or whose last hourly bar is a partial hour, or whose
 * timestamps are not the same midnight — will produce a different open and a
 * different close while agreeing perfectly about every high and low.
 *
 * So the boundary is a parameter. It is not defaulted to the obvious thing
 * silently, because "the obvious thing" is what made the first version of this
 * produce a day whose close was the close of a bar that had not finished
 * forming.
 *
 * **Why this file has to exist at all.** The project measures its strategies on
 * daily bars and runs its analysis on hourly ones, and until now nothing
 * connected the two. Comparing an execution on 1h against an execution on 1d
 * is only meaningful if the daily bars are *the same market*, and the way to
 * establish that is to build one from the other and compare it against a
 * series obtained independently.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Midnights for UTC are multiples of 86 400 000 from the epoch. */
function startOfDay(timestamp: number, offsetHours: number): number {
    return (
        Math.floor((timestamp - offsetHours * HOUR) / DAY) * DAY + offsetHours * HOUR
    );
}

/**
 * Builds daily candles from hourly ones.
 *
 * Days with fewer than `minimumHours` bars are dropped rather than published.
 * A day missing half its bars has a high and a low that were never reached by
 * the market, only by the gap in the feed, and a backtest that trades it is
 * trading a bar that does not exist.
 */
export function resampleToDaily(
    hourly: readonly Candle[],
    timeZone: 'UTC',
    offsetHours = 0,
    minimumHours = 24,
): Candle[] {
    if (hourly.length === 0) {
        return [];
    }

    const ordered = [...hourly].sort((a, b) => a.timestamp - b.timestamp);
    const days: Candle[] = [];
    let current: Candle | null = null;
    let bars = 0;

    for (const candle of ordered) {
        const day = startOfDay(candle.timestamp, offsetHours);

        if (current === null || current.timestamp !== day) {
            if (current !== null && bars >= minimumHours) {
                days.push(current);
            }

            current = {
                timestamp: day,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: 0,
            };
            bars = 0;
        }

        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
        current.volume += candle.volume;
        bars += 1;
    }

    if (current !== null && bars >= minimumHours) {
        days.push(current);
    }

    if (timeZone !== 'UTC') {
        throw new Error(`Unsupported time zone: ${timeZone}`);
    }

    return days;
}
