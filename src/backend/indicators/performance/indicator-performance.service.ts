import { historyConfig } from '../../config/history.config.js';
import type {
    BacklogState,
    BacklogStateByMarket,
} from '../../observability/bounded-write-buffer.js';
import {
    createBoundedWriteBuffer,
    createFlushGuard,
} from '../../observability/bounded-write-buffer.js';
import type { MarketAnalysis } from '../../types/analysis.js';
import type { SignalDirection } from '../../types/direction.js';
import type { Candle } from '../../types/market.js';
import type {
    ForwardHorizon,
    IndicatorLogger,
    IndicatorPerformance,
    IndicatorVote,
    SettleUpdate,
} from './indicator-performance.types.js';
import { FORWARD_HORIZON_NAMES, FORWARD_HORIZONS } from './indicator-performance.types.js';
import type { IndicatorVoteRepository } from './indicator-vote.repository.js';
import { getIndicatorVoteRepository } from './indicator-vote.repository.js';

const HOUR_MS = 3_600_000;

/**
 * Votes that could not be written, held for a retry.
 *
 * The signal history has had a buffer since it was found losing whole hours on
 * shutdown. Votes did not, and they are the records the per-indicator hit rate
 * is computed from: a vote lost to a full connection pool is not a neutral
 * vote, it is a missing observation, and a hit rate over a sample with silent
 * holes is a number nobody can defend.
 */
const voteBacklog = createBoundedWriteBuffer<IndicatorVote[]>({
    maxSize: historyConfig.maxBufferedEntries,
    label: 'indicator_vote',
    // A batch is one market's votes: the whole batch is written under one series,
    // and buffering it whole is what makes the retry replay the same rows.
    marketOf: (batch) => batch[0]?.symbol ?? '',
});

const runVoteFlush = createFlushGuard();

/**
 * Consecutive failed attempts per buffered batch. A `WeakMap` keyed by the batch
 * itself, because batches are re-queued by identity.
 */
const voteAttempts = new WeakMap<IndicatorVote[], number>();

/**
 * The same ceiling the history buffer uses, and the same reason: a batch retried
 * for ever becomes the newest entry in a buffer that drops its oldest, so the
 * retry protects the thing that is broken at the expense of the thing that is not.
 */
const MAX_VOTE_ATTEMPTS = 5;

/**
 * Round-trip cost charged against every settled vote.
 *
 * Same reasoning as the backtest: a vote that only wins by less than it costs
 * to act on is not a vote worth having, and reporting it as a win would be the
 * exact illusion forward returns exist to dispel.
 */
const ROUND_TRIP_COST = 0.002;

/**
 * Typed as `Record<ForwardHorizon, number>` rather than `Record<string, number>`.
 *
 * It was the latter, which means a horizon missing from the table below was not
 * a compile error — it was a lookup that returned `undefined` and multiplied
 * into `NaN` further down, on a measurement rather than on a request. The
 * `horizonMsByName` parameter stays a string map on purpose: it is a test seam,
 * and a seam that tests cannot use is a seam that will be removed by whoever
 * needs it.
 */
const HOUR_MS_BY_HORIZON: Record<ForwardHorizon, number> = {
    '1h': FORWARD_HORIZONS['1h'] * HOUR_MS,
    '4h': FORWARD_HORIZONS['4h'] * HOUR_MS,
    '24h': FORWARD_HORIZONS['24h'] * HOUR_MS,
};

export interface SettleSummary {
    /** Votes that still had at least one horizon waiting. */
    examined: number;
    /** Individual horizon values written, so one vote can add up to three. */
    settled: number;
    /** Votes still awaiting at least one horizon after this pass. */
    stillPending: number;
}

/**
 * Stores what each indicator voted, separately from the consensus.
 *
 * The consensus is one number that hides its inputs: it is impossible to tell
 * afterwards which of the three indicators earned the signal and which merely
 * came along. Storing the votes individually is what makes "is the EMA
 * actually any good?" a question with an answer instead of a matter of faith.
 *
 * **`logger` is required, and that is the point of it.** It used to be optional
 * with a default of nothing, and the production call in `analysis.service.ts`
 * omitted it — so when the database refused the write the votes went into the
 * backlog and the entire catch block, `logger?.warn`, did nothing at all. The
 * failure was total and silent, in a module whose whole reason to exist is to
 * make "how good is the EMA" answerable, and it was invisible for as long as
 * nothing was broken, which is exactly when nobody looks.
 *
 * Required is the honest signature, because omitting this argument turns
 * reporting off rather than choosing a default: a caller that cannot be told
 * about a lost vote should not be recording one. The one place allowed to stay
 * silent is the one that says so by name — `SILENT_HISTORY_LOGGER` in
 * `writeHistory`, which is a test's and an embedding's choice, made once, at the
 * boundary, where it is visible — rather than a default that applies itself
 * quietly at the bottom of a call.
 */
export async function recordIndicatorVotes(
    analysis: MarketAnalysis,
    symbol: string,
    logger: IndicatorLogger,
    repository: IndicatorVoteRepository = getIndicatorVoteRepository(),
): Promise<void> {
    const votes: IndicatorVote[] = analysis.signal.indicators.map(
        (indicator) => ({
            timestamp: analysis.timestamp,
            symbol,
            // The key, not the name. The row is keyed on the indicator, so
            // storing the label would split the series in two the first time
            // the label changed — and "Momentum 100" changes the moment the
            // period becomes configurable. Everything already recorded
            // under a display name stays where it is, readable but
            // no longer written to; migrating it would rewrite history
            // that is already recorded and already settled.
            indicator: indicator.key,
            signal: indicator.signal,
            weight: indicator.weight,
            price: analysis.price,
            // Left null: the future has not happened yet, and storing a
            // zero would make an unresolved vote look like a flat one.
            fwdReturns: {},
        }),
    );

    try {
        await repository.record(votes);
    } catch (error) {
        voteBacklog.push(votes);

        logger?.warn(
            {
                event: 'indicator_vote_record_failed',
                // As in signal history: the counters are the process's, the
                // failure is the market's. A batch holds one market's votes.
                market: symbol,
                buffered: voteBacklog.size,
                dropped: voteBacklog.droppedCount,
                err: error,
            },
            'indicator_vote_record_failed',
        );

        // Without this, a deployment with the poller off would fill the
        // backlog and silently overwrite its oldest hours.
        if (voteBacklog.size >= historyConfig.maxBufferedEntries) {
            await flushIndicatorVoteBacklog(logger, repository);
        }
    }
}

async function writeVoteBacklog(
    logger?: IndicatorLogger,
    repository: IndicatorVoteRepository = getIndicatorVoteRepository(),
): Promise<number> {
    if (voteBacklog.size === 0) {
        return 0;
    }

    const pending = voteBacklog.drain();

    let written = 0;

    let consecutiveFailures = 0;
    let givenUp = 0;

    // Same shape as the history buffer's drain, and for the same reasons: one
    // refused batch stopped everything behind it on every flush, for ever, and with
    // two markets the buffer interleaves them, so one market's bad batch kept the
    // other's votes unwritten.
    //
    // Safe to continue because the upsert is timestamp-guarded —
    // `ON CONFLICT … DO UPDATE … WHERE EXCLUDED.timestamp > indicator_vote.timestamp` —
    // so a batch written out of order can only move its rows forward.
    for (const [index, batch] of pending.entries()) {
        try {
            await repository.record(batch);

            written += batch.length;
            consecutiveFailures = 0;
            voteAttempts.delete(batch);
        } catch (error) {
            consecutiveFailures += 1;

            // Two in a row: the database is down, and the tail is handed back
            // untouched rather than repeating the same refusal for every batch in
            // the buffer once a cycle. One, followed by a success: **this batch** is
            // what the database will not take.
            if (consecutiveFailures >= 2) {
                for (const unprocessed of pending.slice(index)) {
                    voteBacklog.push(unprocessed);
                }

                logger?.warn(
                    {
                        event: 'indicator_vote_flush_failed',
                        written,
                        buffered: voteBacklog.size,
                        err: error,
                    },
                    'indicator_vote_flush_failed',
                );

                break;
            }

            // And a bounded number of retries. Re-queued, a batch becomes the
            // newest in a buffer that evicts its oldest, so a batch that can never
            // be written would sit there protecting itself while the observations
            // the hit rate is computed from were dropped.
            const tries = (voteAttempts.get(batch) ?? 0) + 1;

            if (tries >= MAX_VOTE_ATTEMPTS) {
                voteAttempts.delete(batch);
                givenUp += 1;

                logger?.warn(
                    {
                        event: 'indicator_vote_batch_given_up',
                        attempts: tries,
                        symbol: batch[0]?.symbol,
                        size: batch.length,
                        buffered: voteBacklog.size,
                        err: error,
                    },
                    'indicator_vote_batch_given_up',
                );

                continue;
            }

            voteAttempts.set(batch, tries);
            voteBacklog.push(batch);
        }
    }

    if (givenUp > 0) {
        logger?.warn(
            { event: 'indicator_vote_batches_given_up', givenUp },
            'indicator_vote_batches_given_up',
        );
    }

    return written;
}

/** Retries every batch of votes that failed to write earlier. */
export function flushIndicatorVoteBacklog(
    logger?: IndicatorLogger,
    repository?: IndicatorVoteRepository,
): Promise<number> {
    return runVoteFlush(() => writeVoteBacklog(logger, repository));
}

export function indicatorVoteBacklog(): BacklogState & {
    byMarket: BacklogStateByMarket;
} {
    return {
        buffered: voteBacklog.size,
        dropped: voteBacklog.droppedCount,
        byMarket: voteBacklog.byMarket,
    };
}

type CandleLookup =
    /** The candle that was open at that instant, and is the one that closes it. */
    | { status: 'covers'; candle: Candle }
    /** The instant is inside the newest candle, which has not closed yet. */
    | { status: 'notClosed' }
    /** The instant predates the oldest candle the provider returned. */
    | { status: 'outsideWindow' };

/**
 * Builds a lookup for the candle that covers an instant.
 *
 * A vote is stamped with the wall-clock time the analysis actually ran, which is
 * almost never a candle boundary: a poll at 14:46 stamps 14:46:32, and an hour
 * later the target is 15:46:32 — a moment no hourly candle is labelled with.
 * Looking the target up by equality therefore matched nothing, ever, and no
 * horizon was ever settled. Every forward return stayed null and the accuracy
 * figures had nothing to report.
 *
 * "The candle that covers the target" is found from the series itself rather
 * than from a known interval, so a gap in the data or a changed timeframe does
 * not need this function told about it. The distinction between *not closed yet*
 * and *outside the window* is the whole point: one clears by waiting, the other
 * never will, and a caller that cannot tell them apart will sit forever on a
 * backlog it believes is still on schedule.
 *
 * The cost is that a vote stamped mid-hour settles against a close slightly
 * beyond its nominal horizon, up to one interval. The alternative — the nearest
 * close — truncates it by the same amount the other way and lets a vote settle
 * early, which is worse: an early settlement scores a return over a period
 * shorter than the one the horizon claims.
 */
function candleCovering(candles: Candle[]): (instant: number) => CandleLookup {
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    const stamps = sorted.map((candle) => candle.timestamp);

    return (instant) => {
        const lastIndex = stamps.length - 1;

        if (lastIndex < 0) {
            return { status: 'outsideWindow' };
        }

        let low = 0;
        let high = lastIndex;
        let found = -1;

        while (low <= high) {
            const middle = (low + high) >> 1;
            const middleStamp = stamps[middle];

            if (middleStamp === undefined) {
                break;
            }

            if (middleStamp <= instant) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        if (found === -1) {
            return { status: 'outsideWindow' };
        }

        const candle = sorted[found];
        const stamp = stamps[found];

        if (candle === undefined || stamp === undefined) {
            return { status: 'outsideWindow' };
        }

        // Inside the newest candle, so that candle has not closed and its close
        // is not a price the market has reached yet.
        if (found === lastIndex && stamp < instant) {
            return { status: 'notClosed' };
        }

        return { status: 'covers', candle };
    };
}

function directionOf(signal: SignalDirection): 1 | -1 | 0 {
    if (signal === 'LONG') {
        return 1;
    }

    if (signal === 'SHORT') {
        return -1;
    }

    return 0;
}

/**
 * Fills in the forward returns that have become knowable.
 *
 * Each horizon is settled only once the candle that closes it exists, and the
 * return is signed by the vote's own direction, so a correct short and a
 * correct long are both positive and can be averaged together. A neutral vote
 * settles to zero: it made no prediction, so counting it as a hit or a miss
 * would credit or blame an indicator for staying silent.
 */
export async function settleForwardReturns(
    symbol: string,
    candles: Candle[],
    /** Milliseconds each horizon spans. Overridable so tests need not wait a day. */
    horizonMsByName: Record<string, number> = HOUR_MS_BY_HORIZON,
    logger?: IndicatorLogger,
    repository: IndicatorVoteRepository = getIndicatorVoteRepository(),
): Promise<SettleSummary> {
    let unsettled;

    try {
        unsettled = await repository.listUnsettled(
            symbol,
            historyConfig.maxEntries,
        );
    } catch (error) {
        logger?.warn(
            { event: 'indicator_vote_read_failed', err: error },
            'indicator_vote_read_failed',
        );

        return { examined: 0, settled: 0, stillPending: 0 };
    }

    if (unsettled.length === 0) {
        return { examined: 0, settled: 0, stillPending: 0 };
    }

    const candleAt = candleCovering(candles);
    const updates: SettleUpdate[] = [];

    let settled = 0;
    let stillPending = 0;

    // Why a horizon did not resolve. Kept separate because "waiting for the
    // future" and "the data needed to resolve it is missing" look identical
    // from the outside, and only one of them is ever going to clear.
    const reasons = {
        horizonNotClosed: 0,
        candleMissing: 0,
        unusablePrice: 0,
        unknownHorizon: 0,
    };

    for (const vote of unsettled) {
        const direction = directionOf(vote.signal);
        const returns: Partial<Record<ForwardHorizon, number>> = {};
        let unresolved = 0;

        for (const horizon of vote.pending) {
            const horizonMs = horizonMsByName[horizon];

            if (horizonMs === undefined) {
                reasons.unknownHorizon += 1;
                unresolved += 1;
                continue;
            }

            if (vote.price <= 0) {
                reasons.unusablePrice += 1;
                unresolved += 1;
                continue;
            }

            const found = candleAt(vote.timestamp + horizonMs);

            if (found.status !== 'covers') {
                // The value stays absent rather than being guessed, and the
                // vote keeps waiting.
                if (found.status === 'notClosed') {
                    reasons.horizonNotClosed += 1;
                } else {
                    reasons.candleMissing += 1;
                }

                unresolved += 1;
                continue;
            }

            const target = found.candle;
            const move = (target.close - vote.price) / vote.price;

            returns[horizon] =
                direction === 0 ? 0 : direction * move - ROUND_TRIP_COST;

            settled += 1;
        }

        if (Object.keys(returns).length > 0) {
            updates.push({ timestamp: vote.timestamp, indicator: vote.indicator, returns });
        }

        // A vote with two of three horizons resolved is still waiting, and
        // counting it as finished would hide the two still owed.
        if (unresolved > 0) {
            stillPending += 1;
        }
    }

    // A settlement that quietly never happens is indistinguishable from one
    // that is simply not due yet, from every log line and every figure on the
    // dashboard. Anything other than "waiting for the future" is said out loud.
    const blocked =
        reasons.candleMissing + reasons.unusablePrice + reasons.unknownHorizon;

    if (blocked > 0) {
        logger?.warn(
            {
                event: 'indicator_vote_settle_blocked',
                symbol,
                candleMissing: reasons.candleMissing,
                unusablePrice: reasons.unusablePrice,
                unknownHorizon: reasons.unknownHorizon,
                horizonNotClosed: reasons.horizonNotClosed,
            },
            'indicator_vote_settle_blocked',
        );
    }

    if (updates.length > 0) {
        try {
            await repository.settle(symbol, updates);
        } catch (error) {
            logger?.warn(
                { event: 'indicator_vote_settle_failed', err: error },
                'indicator_vote_settle_failed',
            );

            return { examined: unsettled.length, settled: 0, stillPending: unsettled.length };
        }
    }

    return { examined: unsettled.length, settled, stillPending };
}

/**
 * Per-indicator accuracy, one row per indicator and horizon. *
 * Only votes that had an opinion are counted. Including neutral ones would
 * let an indicator that abstains most of the time show a flattering hit rate
 * built entirely from the few times it spoke.
 */
export async function summarizeIndicatorPerformance(
    symbol: string,
    horizons: ForwardHorizon[] = [...FORWARD_HORIZON_NAMES],
    repository: IndicatorVoteRepository = getIndicatorVoteRepository(),
): Promise<IndicatorPerformance[]> {
    const votes = await repository.list(
        symbol,
        historyConfig.maxEntries * 4,
    );

    const byIndicator = new Map<
        string,
        Map<ForwardHorizon, { values: number[]; best: number; worst: number }>
    >();

    for (const vote of votes) {
        if (vote.signal === 'NEUTRAL') {
            continue;
        }

        let byHorizon = byIndicator.get(vote.indicator);

        if (byHorizon === undefined) {
            byHorizon = new Map();
            byIndicator.set(vote.indicator, byHorizon);
        }

        for (const horizon of horizons) {
            const value = vote.fwdReturns[horizon];

            if (value === undefined) {
                continue;
            }

            let bucket = byHorizon.get(horizon);

            if (bucket === undefined) {
                bucket = { values: [], best: value, worst: value };
                byHorizon.set(horizon, bucket);
            }

            bucket.values.push(value);
            bucket.best = Math.max(bucket.best, value);
            bucket.worst = Math.min(bucket.worst, value);
        }
    }

    const summary: IndicatorPerformance[] = [];

    for (const [indicator, byHorizon] of byIndicator) {
        for (const horizon of horizons) {
            const bucket = byHorizon.get(horizon);

            if (bucket === undefined || bucket.values.length === 0) {
                continue;
            }

            const total = bucket.values.reduce((sum, value) => sum + value, 0);

            summary.push({
                indicator,
                horizon,
                samples: bucket.values.length,
                hitRate: bucket.values.filter((value) => value > 0).length / bucket.values.length,
                averageReturn: total / bucket.values.length,
                best: bucket.best,
                worst: bucket.worst,
            });
        }
    }

    return summary.sort(
        (a, b) => a.indicator.localeCompare(b.indicator) || a.horizon.localeCompare(b.horizon),
    );
}
