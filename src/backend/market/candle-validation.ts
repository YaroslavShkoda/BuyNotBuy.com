import { MAX_CANDLE_LIMIT } from '../config/market.config.js';
import { MarketDataError } from '../errors/market-data.error.js';

import type { Candle } from '../types/market.js';

export type CandleSeriesIssue =
    | 'empty'
    | 'too_many'
    | 'not_increasing'
    | 'duplicate'
    | 'from_the_future'
    | 'not_finite'
    | 'negative'
    | 'ohlc_inconsistent'
    | 'has_gap'
    | 'stale';

/**
 * Continuity on its own: is there a hole in the middle of this series?
 *
 * **Extracted because the two checks behind the optional interval were not one
 * decision.** The gap check and the freshness check both need `intervalMs`, so
 * omitting the argument switched off both — and a backtest, whose series is old
 * by definition, cannot have the freshness check while urgently needing the gap
 * check. Sharing one optional argument made "I need continuity" and "I need a
 * live market" the same request, and the caller who wanted the first got
 * neither.
 *
 * This is the check a historical series needs and cannot be talked out of: every
 * indicator here is a function of the distance between consecutive bars, so a
 * missing bar is not a missing row but a discontinuity the indicator steps over
 * silently. The series stays sorted, unique, finite and range-consistent, and
 * every other check passes it.
 */
export function findCandleContinuityIssue(
    candles: readonly Candle[],
    intervalMs: number,
): CandleSeriesIssue | null {
    for (let index = 1; index < candles.length; index += 1) {
        // Oldest first, which is the order `test-support/candles.ts` builds and
        // the order the whole codebase assumes — `candles[candles.length - 1]`
        // is the newest bar for exactly this reason. The subtraction is
        // later-minus-earlier, so the names had been backwards while the
        // arithmetic stayed right, which is the worst kind of wrong to carry.
        const earlier = candles[index - 1];
        const later = candles[index];

        if (earlier === undefined || later === undefined) {
            continue;
        }

        // `>=` rather than `>`: consecutive bars are exactly one interval
        // apart, so a distance of two intervals is precisely the signature
        // of one bar missing between them.
        if (later.timestamp - earlier.timestamp >= intervalMs * 2) {
            return 'has_gap';
        }
    }

    return null;
}

/**
 * Checks the invariants every indicator depends on.
 *
 * A candle series that is unsorted, contains duplicates or has an impossible
 * OHLC range does not crash: it produces a plausible-looking signal built on
 * wrong numbers. The worst possible failure for a trading dashboard, because
 * nothing downstream would ever flag it. So the series is verified once, at
 * the single point every provider funnels through, and a violation is reported
 * as a provider failure instead of being silently averaged into a signal.
 */
export function findCandleSeriesIssues(
    candles: readonly Candle[],
    now: number,
    maxCount: number = MAX_CANDLE_LIMIT,
    intervalMs?: number,
    /**
     * Whether the newest bar must still be recent.
     *
     * A parameter rather than an omitted interval, because the two answers were
     * being given by the same silence. Continuity wants the interval;
     * freshness wants the interval *and* a market still updating. A caller who
     * wanted the first and not the second had no way to say so.
     */
    requireFresh = true,
): CandleSeriesIssue | null {
    if (candles.length === 0) {
        return 'empty';
    }

    // The default cap is what a single provider response may contain. A series
    // assembled from several pages — a backtest sample — is larger by
    // construction, so the caller states its own ceiling rather than the
    // validator rejecting a legitimate multi-page fetch.
    if (candles.length > maxCount) {
        return 'too_many';
    }

    for (let index = 0; index < candles.length; index += 1) {
        const candle = candles[index];
        const previous = index === 0 ? undefined : candles[index - 1];

        if (candle === undefined) {
            return 'not_finite';
        }

        if (
            !Number.isFinite(candle.timestamp) ||
            !Number.isFinite(candle.open) ||
            !Number.isFinite(candle.high) ||
            !Number.isFinite(candle.low) ||
            !Number.isFinite(candle.close) ||
            !Number.isFinite(candle.volume)
        ) {
            return 'not_finite';
        }

        if (
            candle.open < 0 ||
            candle.high < 0 ||
            candle.low < 0 ||
            candle.close < 0 ||
            candle.volume < 0
        ) {
            return 'negative';
        }

        // The low has to sit below both ends and the high above both, or the
        // bar describes a range the market could not have produced.
        if (
            candle.high < candle.low ||
            candle.open > candle.high ||
            candle.open < candle.low ||
            candle.close > candle.high ||
            candle.close < candle.low
        ) {
            return 'ohlc_inconsistent';
        }

        if (previous !== undefined) {
            if (candle.timestamp === previous.timestamp) {
                return 'duplicate';
            }

            if (candle.timestamp < previous.timestamp) {
                return 'not_increasing';
            }
        }

        // A bar that has not opened yet is the still-forming one slipping past
        // the drop, which would make the latest reading a guess.
        if (candle.timestamp > now) {
            return 'from_the_future';
        }
    }

    // A second pass, once the series is known to be well-formed.
    //
    // Ordering and continuity are checked separately and in that order on
    // purpose. A shuffled series trips both, and reporting the hole first
    // would send whoever is looking at it to a provider outage when the actual
    // problem is that the response was assembled in the wrong order — and the
    // hole it reported would be a symptom of that, not a fact about the feed.
    if (intervalMs !== undefined) {
        const discontinuity = findCandleContinuityIssue(candles, intervalMs);

        if (discontinuity !== null) {
            return discontinuity;
        }

        // The newest bar must be recent. A series that is internally perfect
        // and stopped a week ago produces signals from a week-old market, and
        // every check above would pass it.
        const newest = candles[candles.length - 1];

        // A bar is labelled by the moment it opened, so the newest one is
        // allowed to be up to one interval old and still be forming. Two
        // intervals is a provider that has stopped updating.
        if (
            requireFresh &&
            newest !== undefined &&
            now - newest.timestamp > intervalMs * 2
        ) {
            return 'stale';
        }
    }

    return null;
}

function failOnIssue(
    issue: CandleSeriesIssue,
    provider: string,
    candleCount: number,
): never {
    throw new MarketDataError(
        'Market data provider returned an inconsistent candle series',
        {
            code: 'MARKET_PROVIDER_ERROR',
            cause: {
                provider,
                endpoint: '/api/v3/klines',
                issue,
                candleCount,
            },
        },
    );
}

/**
 * The live check, unchanged: well-formed, non-future, continuous and fresh.
 */
export function assertCandleSeries(
    candles: readonly Candle[],
    now: number,
    provider: string,
    maxCount: number = MAX_CANDLE_LIMIT,
    intervalMs?: number,
): void {
    const issue = findCandleSeriesIssues(candles, now, maxCount, intervalMs);

    if (issue !== null) {
        failOnIssue(issue, provider, candles.length);
    }
}

/**
 * The same checks for a series that is *supposed* to be old.
 *
 * **Exists because `intervalMs` was standing for two different requests.** A
 * backtest wants every check above except freshness — its newest bar is in the
 * past on purpose — and wanting continuity while refusing freshness meant there
 * was no call to make. The only way to ask was to pass no interval at all,
 * which switched off the gap check too. So the backtest checked that its series
 * was sorted, unique, finite and range-consistent, and measured straight across
 * any hole in it, under a comment claiming it did the same checks as the live
 * path.
 *
 * Freshness stays on the live path because there is a provider behind it. Here
 * the series is historical by request, and its age is the caller's business, not
 * an inconsistency.
 */
export function assertHistoricalCandleSeries(
    candles: readonly Candle[],
    now: number,
    provider: string,
    maxCount: number,
    intervalMs: number,
): void {
    const issue = findCandleSeriesIssues(candles, now, maxCount, intervalMs, false);

    if (issue !== null) {
        failOnIssue(issue, provider, candles.length);
    }
}
