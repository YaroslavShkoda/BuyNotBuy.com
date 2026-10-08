/**
 * What does dropping a day cost?
 *
 * `resampleToDaily` drops a day with fewer than 24 hourly bars rather than
 * publishing it, and the fixture notes record eight such days out of 2096. The
 * rule is right — a day missing half its bars has a high and a low the market
 * never reached, and a channel built from it is a channel built from a gap in
 * the feed.
 *
 * But "eight days, dropped correctly" is a claim about the mechanism and not
 * about the data, and this project has a record of mechanisms being right about
 * the wrong thing. So: which eight, and what happens if they are not dropped?
 *
 * The alternative is not hypothetical. A backtest fed incomplete bars does not
 * crash. It quietly builds a narrower channel, sets a stop inside a range the
 * market did not trade, and reports a number. Whether that number is better or
 * worse is an empirical question, and answering it either way is what makes
 * "we drop them" a decision rather than a habit.
 *
 * The eight days are 2021-02-11, 2021-03-06, 2021-04-20, 2021-04-25,
 * 2021-08-13, 2021-09-29, 2023-03-24 and 2026-09-27 — six gaps in the feed
 * during 2021, one in 2023, and the fixture's own last day, which stops at 20
 * hours because the download was taken mid-session.
 *
 * **And the answer is that the rule is right, but it is not the harmless thing
 * it looks like, and the harm is not where the return is.** Letting the eight
 * days back in widens a 20-bar Donchian channel by 5.97% on average and by
 * **233% in the worst single window** — a partial day can invent a high or a
 * low the market never traded, and a channel built from it is wider than the
 * market was.
 *
 * Yet `donchian-20` returns -26.59% on the clean 2088 days and -27.57% on all
 * 2096, over the same 144 trades. A point of return, no change of sign, no
 * change in trade count. The distortion lands in windows where no decision was
 * being made anyway.
 *
 * Which is the useful thing to know, and not the thing a reader would assume
 * from "eight days, dropped correctly". The drop is hygiene, and it is also
 * the only reason a channel in this project means what a channel means. It is
 * worth keeping precisely, and not because it barely moves a number.
 */

import type { Candle } from '../types/market.js';
import { resampleToDaily } from './resample.js';
import { mulberry32 } from './signal-power.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINIMUM_HOURS = 24;

interface DroppedDay {
    readonly timestamp: number;
    readonly hours: number;
    /** The high the partial day reached, which is not the day's high. */
    readonly partialHigh: number;
    readonly partialLow: number;
}

interface Coverage {
    readonly complete: Candle[];
    readonly dropped: readonly DroppedDay[];
    /** Candles for every day, incomplete ones included and clearly marked. */
    readonly withPartial: Candle[];
}

/**
 * Resamples and reports what was left out, rather than only what survived.
 *
 * The two lists are produced from the same pass, so a day cannot appear in one
 * and be missing from the other. A function that returned only the survivors
 * would make "eight days" a number somebody counted by hand once.
 */
export function resampleWithCoverage(
    hourly: readonly Candle[],
    timeZone: 'UTC' = 'UTC',
    offsetHours = 0,
    minimumHours = MINIMUM_HOURS,
): Coverage {
    const complete = resampleToDaily(hourly, timeZone, offsetHours, minimumHours);
    const all = resampleToDaily(hourly, timeZone, offsetHours, 0);
    const kept = new Set(complete.map((candle) => candle.timestamp));
    const dropped: DroppedDay[] = [];

    for (const candle of all) {
        if (kept.has(candle.timestamp)) {
            continue;
        }

        const hours = hourly.filter(
            (bar) =>
                bar.timestamp >= candle.timestamp &&
                bar.timestamp < candle.timestamp + DAY + offsetHours * HOUR,
        ).length;

        dropped.push({
            timestamp: candle.timestamp,
            hours,
            partialHigh: candle.high,
            partialLow: candle.low,
        });
    }

    return { complete, dropped, withPartial: all };
}

/**
 * How much wider does a channel get when a partial day is allowed in?
 *
 * The question a drop is really asking. If the answer is 0.00%, the day could
 * not have changed any rule's decision and the drop is bookkeeping. If it is
 * several percent, a day the market traded was being treated as a day it did
 * not, and that is a different kind of bug.
 */
export function channelInflation(
    complete: readonly Candle[],
    withPartial: readonly Candle[],
    period: number,
): { readonly worst: number; readonly mean: number; readonly windows: number } {
    let worst = 0;
    let sum = 0;
    let windows = 0;

    for (let index = period; index < complete.length; index += 1) {
        const widthOf = (series: readonly Candle[], at: number): number => {
            const slice = series.slice(Math.max(0, at - period), at);
            let high = Number.NEGATIVE_INFINITY;
            let low = Number.POSITIVE_INFINITY;

            for (const candle of slice) {
                high = Math.max(high, candle.high);
                low = Math.min(low, candle.low);
            }

            return high - low;
        };

        const clean = widthOf(complete, index);
        const dirty = widthOf(withPartial, index);

        if (clean <= 0) {
            continue;
        }

        const inflation = (dirty - clean) / clean;
        worst = Math.max(worst, inflation);
        sum += inflation;
        windows += 1;
    }

    return { worst, mean: windows === 0 ? 0 : sum / windows, windows };
}

/**
 * Shuffles the trading days against the price path.
 *
 * The control for "did dropping those eight days remove the only unusual
 * stretch in the sample". A gap in a feed is not a market event, and if the
 * dropped days were all violent, keeping them would import volatility that no
 * rule could have anticipated — which would make the drop look wiser than it
 * is.
 */
export function shuffledGapReturn(
    days: readonly number[],
    seed = 0x9e37_79b9,
    draws = 2000,
): number[] {
    const random = mulberry32(seed);
    const out: number[] = [];

    for (let draw = 0; draw < draws; draw += 1) {
        const order = [...days];

        for (let index = order.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(random() * (index + 1));
            [order[index], order[swap]] = [order[swap]!, order[index]!];
        }

        let total = 0;

        for (let index = 1; index < order.length; index += 1) {
            const before = order[index - 1]!;
            const after = order[index]!;

            if (before > 0) {
                total += after / before - 1;
            }
        }

        out.push(total);
    }

    return out;
}
