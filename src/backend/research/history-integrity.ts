import type { CandleSeriesIssue } from '../market/candle-validation.js';
import { findCandleSeriesIssues } from '../market/candle-validation.js';
import type { Candle } from '../types/market.js';

/**
 * The audit a stored history deserves, and the one thing it refuses to do.
 *
 * The live path validates every provider response at the single point it
 * arrives (`candle-validation.ts`), so a bar that reached the candles table at
 * all passed those checks once. What nothing asks is how the *stored* series
 * reads as a whole, years later, when the question is whether a backtest may
 * trust it: bars written by two ingesters under one identity, a page boundary
 * that dropped a bar, a venue whose open times drifted off the UTC grid, one
 * close-to-close move no market explanation survives.
 *
 * So this module reads a series and reports. **It has no write path and no
 * repair** — the same discipline the ingestion is held to, pointed the other
 * way: a hole is reported, never interpolated; an outlier is named, never
 * smoothed. The module that fixed history while auditing it would be the
 * module whose report nobody can trust.
 *
 * Well-formedness is delegated to the series validator in its historical mode
 * (freshness off, continuity on), so there is one definition of a broken bar
 * and this file does not grow a second one. What the validator does not ask —
 * the UTC grid and the statistical outliers — lives here.
 */

/** A close-to-close move beyond the threshold, largest first. */
export interface CandleOutlier {
    readonly at: number;
    /** Absolute close-to-close move, as a fraction (0.25 is 25%). */
    readonly move: number;
    readonly from: number;
    readonly to: number;
}

export interface HistoryIntegrityReport {
    readonly bars: number;
    readonly firstBarAt: number | null;
    readonly lastBarAt: number | null;
    /**
     * The first well-formedness or continuity issue, in the series validator's
     * own vocabulary, or null. Freshness is deliberately not asked: a stored
     * series is old by definition, and its age is the caller's business.
     */
    readonly structuralIssue: CandleSeriesIssue | null;
    /** Bars whose open time is not an exact multiple of the interval. */
    readonly misaligned: readonly number[];
    /** Close-to-close moves beyond the threshold, largest first. */
    readonly outliers: readonly CandleOutlier[];
    readonly intervalMs: number;
    /** The threshold the outlier scan ran with, so the report is reproducible. */
    readonly outlierThreshold: number;
}

/** Bars per hour of 1h history whose move exceeds a quarter — an extreme ask. */
export const DEFAULT_OUTLIER_THRESHOLD = 0.25;

/** How many misaligned bars an audit names before it stops listing. */
const MAX_LISTED = 20;

/**
 * Bars whose open time is off the interval's UTC grid.
 *
 * Venue klines open on exact multiples of the interval in epoch milliseconds,
 * so a bar opening at an odd offset is a timestamp converted through a local
 * timezone somewhere between the venue and the table. The check is exact
 * integer arithmetic, because a bar that is half a millisecond early is as
 * much off the grid as one that is an hour early.
 */
export function findUtcGridMisalignment(
    candles: readonly Candle[],
    intervalMs: number,
): number[] {
    const misaligned: number[] = [];

    for (const candle of candles) {
        if (candle.timestamp % intervalMs !== 0) {
            misaligned.push(candle.timestamp);

            if (misaligned.length >= MAX_LISTED) {
                break;
            }
        }
    }

    return misaligned;
}

/**
 * Close-to-close moves beyond a threshold, largest first.
 *
 * Deliberately naive: no z-scores, no volatility model — those explain a move,
 * and explaining comes after naming. A threshold on the raw fraction is
 * something a reader can check by hand against any two closes.
 */
export function findCandleOutliers(
    candles: readonly Candle[],
    threshold: number = DEFAULT_OUTLIER_THRESHOLD,
): CandleOutlier[] {
    const outliers: CandleOutlier[] = [];

    for (let index = 1; index < candles.length; index += 1) {
        const earlier = candles[index - 1];
        const later = candles[index];

        if (earlier === undefined || later === undefined) {
            continue;
        }

        if (earlier.close <= 0) {
            continue;
        }

        const move = Math.abs(later.close / earlier.close - 1);

        if (move > threshold) {
            outliers.push({ at: later.timestamp, move, from: earlier.close, to: later.close });
        }
    }

    return outliers.sort((left, right) => right.move - left.move);
}

/**
 * The whole audit over one series, oldest first, no writes.
 *
 * The structural check runs once, in the validator's historical mode; the grid
 * and the outlier scan run over the same array untouched. The input is not
 * reordered, not filtered, not repaired — an audit that hands back something
 * other than what it was given has already lied about the series it measured.
 */
export function auditCandleHistory(
    candles: readonly Candle[],
    intervalMs: number,
    outlierThreshold: number = DEFAULT_OUTLIER_THRESHOLD,
): HistoryIntegrityReport {
    return {
        bars: candles.length,
        firstBarAt: candles[0]?.timestamp ?? null,
        lastBarAt: candles.at(-1)?.timestamp ?? null,
        structuralIssue: findCandleSeriesIssues(
            candles,
            Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER,
            intervalMs,
            false,
        ),
        misaligned: findUtcGridMisalignment(candles, intervalMs),
        outliers: findCandleOutliers(candles, outlierThreshold),
        intervalMs,
        outlierThreshold,
    };
}

/** The report as lines a person reads, one finding per line. */
export function describeIntegrityReport(report: HistoryIntegrityReport): string[] {
    const lines: string[] = [];

    lines.push(
        `баров: ${report.bars}` +
            (report.firstBarAt === null || report.lastBarAt === null
                ? ''
                : `, ${new Date(report.firstBarAt).toISOString()} — ` +
                  `${new Date(report.lastBarAt).toISOString()}`),
    );
    lines.push(
        `структура: ${
            report.structuralIssue === null ? 'целостна' : report.structuralIssue
        }`,
    );
    lines.push(
        `сетка UTC (${report.intervalMs} мс): ${
            report.misaligned.length === 0
                ? 'выровнена'
                : `смещённых баров ${report.misaligned.length}` +
                  (report.misaligned.length >= MAX_LISTED ? '+' : '') +
                  `: ${report.misaligned
                      .slice(0, MAX_LISTED)
                      .map((timestamp) => new Date(timestamp).toISOString())
                      .join(', ')}`
        }`,
    );
    lines.push(
        `выбросы (порог ${(report.outlierThreshold * 100).toFixed(0)}%): ` +
            (report.outliers.length === 0
                ? 'нет'
                : report.outliers
                      .slice(0, MAX_LISTED)
                      .map(
                          (outlier) =>
                              `${new Date(outlier.at).toISOString()} ` +
                              `${(outlier.move * 100).toFixed(2)}% ` +
                              `(${outlier.from} → ${outlier.to})`,
                      )
                      .join('; ')),
    );

    return lines;
}
