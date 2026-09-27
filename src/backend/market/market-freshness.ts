import { marketConfig } from '../config/market.config.js';

import type { CandleSeriesIssue } from './candle-validation.js';

/**
 * One vocabulary for "how much should a caller trust this snapshot".
 *
 * The state is derived in one place from three facts — how old the snapshot is,
 * whether the venue answered, and whether the series is the whole picture — and
 * every caller reads the result rather than re-deriving it. That is the point:
 * before this existed, "is the dashboard showing live data" was answered
 * differently by the cache, the API header, the analysis logger and the history
 * writer, and there was no way to check that they agreed.
 *
 * The six states, and what each one is for:
 *
 * - `fresh` — inside the cache TTL, the venue answered or was recently
 *   answering, and the series is whole. Nothing to say.
 * - `provider_failed` — the data is inside the TTL and is exactly as current as
 *   a normal cache hit, but every configured venue is currently refusing us.
 *   Distinct from `stale` because the data is not behind: the market feed is
 *   dead and the dashboard is still serving a good snapshot with no indication
 *   of it. Reporting this as `fresh` is how a full outage stays invisible until
 *   someone opens the chart and asks why it stopped moving.
 * - `stale` — the snapshot is past the TTL but inside `maxStaleMs`, and is being
 *   served because the venue failed. The data is real and behind.
 * - `partially_available` — the snapshot is inside every limit, but the series
 *   has holes or too few bars for the warm-up. Served only when the configured
 *   policy tolerates it; the default rejects instead.
 * - `expired` — older than `maxStaleMs`. Never served. Reported so a caller
 *   that was refused can tell "too old" from "no data".
 * - `unavailable` — the venue failed and there is nothing cached to fall back
 *   on. The request fails.
 */
export type MarketFreshness =
    | 'fresh'
    | 'provider_failed'
    | 'stale'
    | 'partially_available'
    | 'expired'
    | 'unavailable';

export interface FreshnessInput {
    /** Age of the cached snapshot, or null when nothing is cached. */
    ageMs: number | null;
    /** Whether a venue answered this request. */
    providerAnswered: boolean;
    /**
     * Whether at least one configured venue is currently able to answer.
     *
     * Separate from `providerAnswered` on purpose: a cache hit means no venue
     * was asked, so "the venue is down" is invisible unless it is looked up
     * separately. That is precisely the hole `provider_failed` exists to close.
     */
    anyProviderAvailable: boolean;
    /** Series problems that were tolerated rather than rejected. */
    toleratedIssues: readonly CandleSeriesIssue[];
    /** Bars the indicator warm-up needs, for the completeness check. */
    requiredCandles?: number | undefined;
    /** Bars actually in the series. */
    actualCandles?: number | undefined;
}

/**
 * The one place the six states are decided.
 *
 * Order is the design, and it runs from "worst reason to return nothing" to
 * "nothing special to report":
 *
 * 1. No data at all is `unavailable` — there is no snapshot to have an age.
 * 2. Data older than `maxStaleMs` is `expired`, whatever the provider did. A
 *    fresh answer would have replaced it, so reaching here means the caller is
 *    being refused, and the refusal is about age rather than about the venue.
 * 3. A series that cannot support a signal is `partially_available`. Checked
 *    before the provider verdict because a hole in the data is a fact about the
 *    data, and it stays a fact even if the venue is also down.
 * 4. Past the TTL is `stale`.
 * 5. Inside the TTL with no venue reachable is `provider_failed`.
 * 6. Everything else is `fresh`.
 */
export function classifyFreshness(input: FreshnessInput): MarketFreshness {
    if (input.ageMs === null) {
        return 'unavailable';
    }

    if (input.ageMs > marketConfig.maxStaleMs) {
        return 'expired';
    }

    if (isPartial(input)) {
        return 'partially_available';
    }

    if (input.ageMs > marketConfig.cacheTtlMs) {
        return 'stale';
    }

    if (!input.providerAnswered && !input.anyProviderAvailable) {
        return 'provider_failed';
    }

    return 'fresh';
}

function isPartial(input: FreshnessInput): boolean {
    if (input.toleratedIssues.length > 0) {
        return true;
    }

    const required = input.requiredCandles;
    const actual = input.actualCandles;

    return (
        required !== undefined &&
        actual !== undefined &&
        actual < required
    );
}

/**
 * Whether a state describes data that may be turned into a signal.
 *
 * `partially_available` is deliberately excluded: it is reported so an operator
 * can see the series is incomplete, not so the pipeline can quietly build on it.
 * The policy that decides whether to tolerate a hole lives in the validation
 * layer; by the time a snapshot reaches here, this is the question every other
 * caller is asking, and only two states are allowed to answer yes.
 */
export function isUsableForSignal(freshness: MarketFreshness): boolean {
    return freshness === 'fresh' || freshness === 'provider_failed';
}

/** Whether the snapshot was served from cache rather than fetched. */
export function isCached(freshness: MarketFreshness): boolean {
    return (
        freshness === 'stale' ||
        freshness === 'provider_failed' ||
        freshness === 'partially_available'
    );
}
