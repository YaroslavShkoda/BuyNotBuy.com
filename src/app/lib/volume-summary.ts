import type { Candle } from '../types/analysis';

/** The hour a volume extreme happened in, not just how big it was. */
export interface VolumeExtreme {
    value: number;
    timestamp: number;
}

export interface VolumeSummary {
    /** Hours actually counted. Non-finite volumes are dropped, not zeroed. */
    count: number;
    total: number;
    average: number;
    /**
     * The typical hour, with the outliers ignored.
     *
     * Reported next to the average because the two answer different questions
     * and disagreeing between them is the signal: an average well above the
     * median means the window was carried by a few loud hours rather than being
     * busy throughout.
     */
    median: number;
    max: VolumeExtreme | null;
    min: VolumeExtreme | null;
    /**
     * The peak as a multiple of the average — the single most useful number for
     * "was anything unusual here", because it is scale-free: a 40M peak means
     * the same thing on a quiet market and a frantic one.
     */
    peakRatio: number;
}

const EMPTY: VolumeSummary = {
    count: 0,
    total: 0,
    average: 0,
    median: 0,
    max: null,
    min: null,
    peakRatio: 0,
};

/**
 * Reduces the visible window's volumes to the handful of figures worth reading
 * at a glance.
 *
 * This is deliberately the *absolute* numbers, not the ratios the bar heights
 * use. The bars are drawn against a trailing local median so a venue change
 * cannot flatten them, which is what makes the chart survive a failover — and it
 * also means a bar's height no longer says how much was traded. These figures put
 * the amounts back, so the panel can be read as a quantity and not only as
 * "busier or quieter than the last few hours".
 *
 * The caveat that follows from that same design is worth stating: if the window
 * spans a venue switch, these figures mix two venues' volume scales and the
 * peak ratio will look extreme for a reason that has nothing to do with the
 * market. The bar heights are immune to it; these numbers are not.
 */
export function summariseVolume(candles: Candle[]): VolumeSummary {
    const volumes = candles
        .filter((candle) => Number.isFinite(candle.volume))
        .map((candle) => candle.volume);

    if (volumes.length === 0) {
        return EMPTY;
    }

    const total = volumes.reduce((sum, value) => sum + value, 0);
    const average = total / volumes.length;

    const sorted = [...volumes].sort((left, right) => left - right);
    const middle = sorted.length >> 1;

    const median = sorted.length % 2 === 1
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;

    // Tracked over the candles rather than read off `sorted`, so each extreme
    // carries the hour it belongs to. Earliest wins a tie: two hours with the
    // same volume are the same figure, and picking the later one arbitrarily
    // would move the label for no reason.
    let max: VolumeExtreme | null = null;
    let min: VolumeExtreme | null = null;

    for (const candle of candles) {
        if (!Number.isFinite(candle.volume)) continue;

        if (max === null || candle.volume > max.value) {
            max = { value: candle.volume, timestamp: candle.timestamp };
        }

        if (min === null || candle.volume < min.value) {
            min = { value: candle.volume, timestamp: candle.timestamp };
        }
    }

    return {
        count: volumes.length,
        total,
        average,
        median,
        max,
        min,
        // A window whose volumes are all zero has no peak worth calling one.
        peakRatio: average > 0 && max !== null ? max.value / average : 0,
    };
}
