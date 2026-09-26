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
        for (let index = 1; index < candles.length; index += 1) {
            const newer = candles[index - 1];
            const older = candles[index];

            if (newer === undefined || older === undefined) {
                continue;
            }

            // A hole in the series. Every indicator here is a function of the
            // distance between consecutive bars — the EMA's decay, momentum's
            // lookback, the stochastic's window — so a missing bar is not a
            // missing row, it is a discontinuity the indicator silently steps
            // over. The result is a well-formed number computed across a gap,
            // which is the failure the rest of this function exists to prevent,
            // only harder to see: the series is sorted, unique, finite and has
            // a consistent OHLC range, and every one of those checks passes.
            //
            // `>=` rather than `>`: consecutive bars are exactly one interval
            // apart, so a distance of two intervals is precisely the signature
            // of one bar missing between them.
            if (older.timestamp - newer.timestamp >= intervalMs * 2) {
                return 'has_gap';
            }
        }

        // The newest bar must be recent. A series that is internally perfect
        // and stopped a week ago produces signals from a week-old market, and
        // every check above would pass it.
        const newest = candles[candles.length - 1];

        // A bar is labelled by the moment it opened, so the newest one is
        // allowed to be up to one interval old and still be forming. Two
        // intervals is a provider that has stopped updating.
        if (newest !== undefined && now - newest.timestamp > intervalMs * 2) {
            return 'stale';
        }
    }

    return null;
}

export function assertCandleSeries(
    candles: readonly Candle[],
    now: number,
    provider: string,
    maxCount: number = MAX_CANDLE_LIMIT,
    intervalMs?: number,
): void {
    const issue = findCandleSeriesIssues(candles, now, maxCount, intervalMs);

    if (issue === null) {
        return;
    }

    throw new MarketDataError(
        'Market data provider returned an inconsistent candle series',
        {
            code: 'MARKET_PROVIDER_ERROR',
            cause: {
                provider,
                endpoint: '/api/v3/klines',
                issue,
                candleCount: candles.length,
            },
        },
    );
}
