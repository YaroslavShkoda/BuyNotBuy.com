import type { Candle } from '../types/analysis';

/**
 * Turns notional volumes into bar heights, in 0..1.
 *
 * The obvious scaling — divide by the largest bar — breaks the moment the venue
 * changes, and the venue can change now. Measured live on the same market, the
 * two exchanges report volumes around 39 times apart, so a series that switches
 * mid-window leaves the new bars at two percent of the old height and the panel
 * looks like the market died.
 *
 * So each bar is measured against its own recent past rather than against the
 * chart's maximum. A bar at twice its local norm fills the plot, one at the norm
 * sits at half height, and a bar from either venue lands in the same place. What
 * is lost is the absolute range — a quiet week and a frantic one now look alike,
 * and the levels are read from the tooltip rather than from the bar, which is
 * where the actual number was always going to be read from.
 *
 * The median is doing the work, not the mean: a single volume spike would drag
 * a mean upward and then flatten every ordinary bar around it.
 *
 * It is a trailing reference, so a venue change is not corrected instantly —
 * the bars either side of the switch are drawn against a mixed norm and come out
 * wrong for a few hours. That is the deliberate trade for never probing the
 * primary venue mid-outage, and it is a transient after a rare event rather than
 * a standing distortion.
 */

/**
 * Candles that define "normal" for one bar.
 *
 * A median over a window only flips to a new regime once the new data outnumbers
 * the old, so the window sets the lag before a venue change stops distorting the
 * bars: at 24 hourly candles the chart would show short bars for up to a day.
 * Twelve halves that to a shift of a few hours, which is short enough to be a
 * footnote after an outage and long enough that an ordinary busy hour does not
 * become its own reference.
 */
const REFERENCE_WINDOW = 12;

/** A bar at twice its own norm fills the plot; past that it is a spike. */
const MAX_RATIO = 2;

function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length >> 1;

    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? 0;
    }

    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Heights aligned index-for-index with `candles`.
 *
 * Each bar uses the candles strictly before it, never including itself: a bar
 * that contributed to its own reference would halve its own height, and the
 * single loudest bar would be the one drawn shortest.
 */
export function buildVolumeScale(candles: Candle[]): number[] {
    const volumes = candles.map((candle) => candle.volume);
    // The fallback for the opening bars, which have no past to be compared with.
    const seriesMedian = median(volumes);

    return volumes.map((volume, index) => {
        const reference = median(
            volumes.slice(Math.max(0, index - REFERENCE_WINDOW), index),
        );

        const norm = reference > 0 ? reference : seriesMedian;

        if (norm <= 0) {
            // A pair that has never traded has no normal to measure against, and
            // every bar is the same height rather than all of them flat.
            return volumes.some((value) => value > 0) ? 0 : 1;
        }

        const ratio = volume / norm;

        return Math.min(Math.max(ratio, 0), MAX_RATIO) / MAX_RATIO;
    });
}
