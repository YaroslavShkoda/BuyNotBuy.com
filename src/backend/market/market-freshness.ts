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

interface FreshnessInput {
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

/**
 * Removed: `isCached`.
 *
 * It answered "was this snapshot served from cache rather than fetched", and the
 * argument it was given could not carry the answer. `MarketFreshness` is a
 * function of three things — age, whether a venue could answer, and the health
 * of the series — and none of them distinguishes memory from the wire. The
 * cache-hit branch of `getMarketData` is the proof: it classifies with
 * `providerAnswered: false` and an age inside the TTL and gets `fresh`, which is
 * the same word the successful-fetch branch writes by hand. So the predicate
 * returned `false` for the commonest cache hit in the system.
 *
 * Three tests held it up, and two of their names asserted distinctions their own
 * arguments could not make: one said `provider_failed` was "not a cache hit" and
 * asserted that it was; another said a "freshly fetched snapshot" was not cached
 * and asserted only on the word `fresh`, which a cache hit also produces. The
 * defect was pinned as intent, which is how it survived.
 *
 * **Why deletion rather than repair.** Repair is possible and would be small: the
 * three return sites in `getMarketData` each know which they are, so a
 * `fromCache: boolean` on the result would make the question answerable. It was
 * not done here because there is no reader to answer it. `/api/market` already
 * returns `ageMs`, which is zero for a fetch and non-zero for both cache paths, so
 * a client can already tell — and a field nobody reads is the same
 * mechanism-built-and-wired-nowhere that this round's predecessor spent its whole
 * budget closing. `docs/invariants.md` §17 is the rule: code with no path is not
 * working code.
 *
 * If somebody later needs the fact, the honest place is a field on the result
 * carrying it, and `research/uncalled-exports.pinned.ts` should then be asked to
 * fail, which is the moment to delete that pin having used the code.
 */
