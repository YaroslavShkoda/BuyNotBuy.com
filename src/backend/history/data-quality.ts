import type { MarketFreshness } from '../market/market-freshness.js';
import { isUsableForSignal } from '../market/market-freshness.js';
import type { Candle } from '../types/market.js';

/**
 * How much a set of candles can be trusted, and whether it is enough to decide
 * anything from.
 *
 * A signal is a function of its inputs, and this is the part that asks whether
 * the inputs were there. The reason it is a score rather than a boolean is that
 * the interesting cases are not the broken ones. A series with a hole in the
 * middle is a series whose EMA stepped over the hole and produced a smooth,
 * plausible number — the failure this whole system exists to avoid, and it is
 * invisible downstream. The other interesting case is a series that is short
 * but honest, which is enough to answer "is the market moving" and not enough to
 * answer "how far does it usually move".
 *
 * So the score is a number, it is reported, and the decision to build a signal
 * is a separate, named threshold rather than a comparison somebody retypes.
 */

export type QualityFactor =
    | 'freshness'
    | 'coverage'
    | 'gaps'
    | 'venue'
    | 'validation';

export interface QualityBreakdown {
    readonly factor: QualityFactor;
    /** 0 means unusable, 1 means perfect. */
    readonly score: number;
    /** What the score was computed from, in numbers a reader can check. */
    readonly detail: string;
}

export interface DataQuality {
    /** 0..1. The mean of the factor scores. */
    readonly score: number;
    /** The floor. The mean alone hides a series that is fine everywhere except one hole. */
    readonly floor: number;
    /** The worst factor. */
    readonly worst: QualityFactor;
    /** The freshness state the snapshot path decided, when it decided one. */
    readonly freshness: MarketFreshness | null;
    readonly factors: readonly QualityBreakdown[];
    /** Whether this is enough to compute a signal from. */
    readonly usable: boolean;
    /** Why not, when `usable` is false. Names the factor, not a number. */
    readonly blockedBy: QualityFactor | null;
}

export interface DataQualityInput {
    readonly candles: readonly Candle[];
    readonly now: number;
    readonly intervalMs: number;
    /** The venue these candles came from. */
    readonly provider: string;
    /** Whether that venue is currently answering. */
    readonly providerAvailable?: boolean;
    /** Whether these candles came from a fallback rather than the primary. */
    readonly fallback?: boolean;
    /** Bars a signal needs. Fewer than this is "honest but short". */
    readonly requiredBars?: number;
    /** Validation issues found while this series was being produced. */
    readonly validationIssues?: number;
    /**
     * The freshness state the snapshot path already decided, if there is one.
     *
     * Passed in rather than derived, and that is the whole point. `expired`
     * means "older than the cache may serve", which is a statement about a
     * cached snapshot. A series whose newest bar is two hours old is a perfectly
     * good series to compute a signal from and a snapshot nobody should serve,
     * and re-deriving one from the other turns the first into a refusal that
     * nobody asked for.
     */
    readonly snapshotFreshness?: MarketFreshness;
    /** The bar below which the score stops describing anything usable. */
    readonly usableThreshold?: number;
}

export const DEFAULT_REQUIRED_BARS = 200;
export const DEFAULT_USABLE_THRESHOLD = 0.6;

/**
 * The worst factor decides usability, not the mean.
 *
 * A series that is fresh, complete, from a healthy venue and has one hole in
 * the middle averages to a good number, and the one hole is the only thing
 * that matters: every indicator here is a function of the distance between
 * consecutive bars, so a missing bar is a discontinuity the indicator steps
 * over and reports a perfectly well-formed value for.
 */
export function assessDataQuality(
    input: DataQualityInput,
): DataQuality {
    const requiredBars = input.requiredBars ?? DEFAULT_REQUIRED_BARS;
    const threshold = input.usableThreshold ?? DEFAULT_USABLE_THRESHOLD;

    const factors: QualityBreakdown[] = [
        freshnessFactor(input),
        coverageFactor(input, requiredBars),
        gapsFactor(input),
        venueFactor(input),
        validationFactor(input),
    ];

    const score =
        factors.reduce((total, factor) => total + factor.score, 0) /
        factors.length;

    const worst = factors.reduce((current, worstSoFar) =>
        factorScore(worstSoFar) < factorScore(current) ? worstSoFar : current,
    );

    // The mean is the headline and the floor is the gate. A series that is
    // perfect on four counts and useless on the fifth has a high mean and is
    // not buildable, and reporting only the mean is how that gets used.
    //
    // A snapshot state, when there is one, is a veto rather than a factor: the
    // snapshot path has already decided whether this data may be served, and a
    // quality score that outvoted it would leave two components disagreeing
    // about the same candles.
    const usable =
        factorScore(worst) >= threshold &&
        (input.snapshotFreshness === undefined ||
            isUsableForSignal(input.snapshotFreshness));

    return {
        score,
        floor: factorScore(worst),
        worst: worst.factor,
        freshness: input.snapshotFreshness ?? null,
        factors,
        usable,
        blockedBy: usable ? null : worst.factor,
    };
}

/** The floor, for callers that must gate on it rather than report it. */
export function qualityFloor(quality: DataQuality): number {
    return quality.floor;
}

function factorScore(factor: QualityBreakdown): number {
    return factor.score;
}

function freshnessFactor(input: DataQualityInput): QualityBreakdown {
    const newest = input.candles.at(-1)?.timestamp;
    const latest = input.candles.reduce(
        (newestSoFar, candle) => Math.max(newestSoFar, candle.timestamp),
        Number.NEGATIVE_INFINITY,
    );

    if (!Number.isFinite(latest) || latest === Number.NEGATIVE_INFINITY) {
        return { factor: 'freshness', score: 0, detail: 'no candles' };
    }

    const age = input.now - latest;
    const barsOld = age / input.intervalMs;

    // Measured in intervals, not in cache TTLs. A bar can be up to one interval
    // old and still be the newest thing that exists; past two, the data is no
    // longer describing the market the caller is looking at, and the honest
    // score is "half", not a number that pretends to know more.
    return {
        factor: 'freshness',
        score: barsOld > 2 ? 0 : barsOld > 1 ? 0.5 : 1,
        detail: `${barsOld.toFixed(1)} bars old, newest ${
            newest === undefined ? 'unknown' : 'known'
        }`,
    };
}

function coverageFactor(
    input: DataQualityInput,
    requiredBars: number,
): QualityBreakdown {
    const count = input.candles.length;

    if (count === 0) {
        return { factor: 'coverage', score: 0, detail: 'no candles' };
    }

    return {
        factor: 'coverage',
        score: Math.min(1, count / requiredBars),
        detail: `${count} of ${requiredBars} bars`,
    };
}

function gapsFactor(input: DataQualityInput): QualityBreakdown {
    const { candles, intervalMs } = input;

    if (candles.length < 2) {
        return { factor: 'gaps', score: 0, detail: 'not enough bars to have a gap' };
    }

    let gaps = 0;

    for (let index = 1; index < candles.length; index += 1) {
        const previous = candles[index - 1]?.timestamp ?? 0;
        const current = candles[index]?.timestamp ?? 0;

        // The absolute difference, because a series handed to this function
        // may be ordered oldest-first or newest-first, and only one of the two
        // is a subset of the other's arithmetic. Subtracting in the wrong
        // direction yields a negative distance, every comparison passes, and a
        // series with a hole in the middle reports itself as continuous — the
        // one answer that cannot be checked later.
        //
        // Two intervals is precisely one bar missing between them: consecutive
        // bars are exactly one interval apart.
        if (Math.abs(current - previous) >= intervalMs * 2) {
            gaps += 1;
        }
    }

    const intervals = candles.length - 1;

    return {
        factor: 'gaps',
        // Zero or one, never in between, and that is the existing position of
        // the series validator: a hole is an issue, not a matter of degree.
        //
        // The alternative — scoring one hole in four hundred bars at 0.9975 —
        // reads as generosity and is not. Every indicator here is a function of
        // the distance between consecutive bars, so a missing bar is a
        // discontinuity the indicator steps over and then reports a perfectly
        // well-formed value for. Nothing downstream can see it, which is
        // exactly why the gap has to be fatal here rather than a rounding
        // error in a score nobody is required to read.
        score: gaps === 0 ? 1 : 0,
        detail:
            gaps === 0
                ? 'continuous'
                : `${gaps} gap${gaps === 1 ? '' : 's'} in ${intervals} intervals`,
    };
}

function venueFactor(input: DataQualityInput): QualityBreakdown {
    const available = input.providerAvailable ?? true;
    const fallback = input.fallback ?? false;

    if (!available) {
        return {
            factor: 'venue',
            score: 0,
            detail: `${input.provider} is not answering`,
        };
    }

    if (fallback) {
        // A fallback's numbers are correct and its provenance is weaker: they
        // are a different venue's print of the same market, and a result
        // measured across a switch mixes two series.
        return {
            factor: 'venue',
            score: 0.8,
            detail: `${input.provider} is serving in place of the primary`,
        };
    }

    return { factor: 'venue', score: 1, detail: input.provider };
}

function validationFactor(input: DataQualityInput): QualityBreakdown {
    const issues = input.validationIssues ?? 0;

    if (issues === 0) {
        return { factor: 'validation', score: 1, detail: 'clean' };
    }

    // Per-bar, so one rejected bar in a thousand is a rounding error and a
    // thousand rejected bars in a thousand is an empty series.
    return {
        factor: 'validation',
        score: Math.max(0, 1 - issues / Math.max(1, input.candles.length)),
        detail: `${issues} rejected bar${issues === 1 ? '' : 's'}`,
    };
}

/**
 * The series this system is currently describing, for a diagnostic that needs
 * to name it without being handed it.
 */
export function describeSeries(key: {
    provider: string;
    symbol: string;
    interval: string;
}): string {
    return `${key.provider}:${key.symbol}:${key.interval}`;
}
