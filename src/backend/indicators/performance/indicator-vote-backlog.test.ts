import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushIndicatorVoteBacklog,
    indicatorVoteBacklog,
    recordIndicatorVotes,
} from './indicator-performance.service.js';

import type { MarketAnalysis } from '../../types/analysis.js';
import type { IndicatorVoteRepository } from './indicator-vote.repository.js';

/**
 * The one logger this file needs, and named.
 *
 * `reporting` exists because of what this file now asserts: a refused write is
 * reported, and reporting is not optional. While the logger parameter had a
 * default of nothing, the production call in `analysis.service.ts` omitted it and
 * every one of these cases was a *silent* one — the vote was buffered correctly
 * in all four tests and the failure was announced in none of them, which is what
 * a green suite over a broken guarantee looks like.
 */
const reporting = { warn: vi.fn() };

function analysis(): MarketAnalysis {
    return {
        timestamp: 1_700_000_000_000,
        symbol: 'BTCUSDT',
        price: 100_000,
        signal: {
            signal: 'LONG',
            confidence: 61,
            reason: 'потому что',
            indicators: [
                {
                    key: 'ema',
                    name: 'EMA 300',
                    signal: 'LONG',
                    reason: 'выше',
                    weight: 0.5,
                },
                {
                    key: 'momentum',
                    name: 'Momentum 100',
                    signal: 'LONG',
                    reason: 'растёт',
                    weight: 0.4,
                },
            ],
        },
    } as unknown as MarketAnalysis;
}

function repositoryThatFails(times: number): {
    repository: IndicatorVoteRepository;
    attempts: () => number;
    written: () => number;
} {
    let attempts = 0;
    let written = 0;

    const repository = {
        record: vi.fn(async (votes: unknown[]) => {
            attempts += 1;

            if (attempts <= times) {
                throw new Error('connection terminated');
            }

            written += votes.length;
        }),
        list: vi.fn(),
        listUnsettled: vi.fn(),
        settle: vi.fn(),
        count: vi.fn(),
        schemaVersion: vi.fn(),
        durabilitySettings: vi.fn(),
    } as unknown as IndicatorVoteRepository;

    return { repository, attempts: () => attempts, written: () => written };
}

describe('indicator vote write backlog', () => {
    // The backlog is module-level, exactly as it is in production, so it
    // carries between tests. Draining it with a repository that always
    // succeeds gives every test a known-empty starting point, which is what
    // lets the counts below be exact instead of relative.
    beforeEach(async () => {
        reporting.warn.mockClear();
        await flushIndicatorVoteBacklog(undefined, {
            record: async () => undefined,
        } as unknown as IndicatorVoteRepository);
    });

    it('holds a vote that could not be written instead of losing it', async () => {
        const { repository } = repositoryThatFails(1);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, repository);

        // A vote lost to a full connection pool is not a neutral vote, it is a
        // missing observation — and the per-indicator hit rate is computed
        // from exactly this table.
        expect(indicatorVoteBacklog().buffered).toBe(1);
    });

    it('and says so, which is the half that was missing', async () => {
        const { repository } = repositoryThatFails(Number.POSITIVE_INFINITY);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, repository);

        // All four tests above buffered correctly while the production call
        // passed no logger at all, and every one of them was green. Buffering
        // without announcing is the shape of a system that loses observations
        // quietly, and the per-indicator hit rate is computed from this table —
        // so a table that quietly stops accepting writes becomes a table that
        // quietly reports the wrong hit rate, and reports it as a fact about the
        // indicator rather than as a fact about the database.
        expect(reporting.warn).toHaveBeenCalledTimes(1);

        const [context, message] = reporting.warn.mock.calls[0] as [
            Record<string, unknown>,
            string,
        ];

        expect(message).toBe('indicator_vote_record_failed');
        expect(context.event).toBe('indicator_vote_record_failed');
        expect(context.buffered).toBe(1);
    });

    it('writes the held votes on the next flush', async () => {
        const { repository, written } = repositoryThatFails(1);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, repository);
        await flushIndicatorVoteBacklog(undefined, repository);

        expect(written()).toBe(2);
        expect(indicatorVoteBacklog().buffered).toBe(0);
    });

    it('re-queues the whole tail when a flush fails part way', async () => {
        const { repository } = repositoryThatFails(Number.POSITIVE_INFINITY);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, repository);
        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, repository);

        expect(indicatorVoteBacklog().buffered).toBe(2);

        await flushIndicatorVoteBacklog(undefined, repository);

        // Re-queueing only the batch that failed would discard everything after
        // it — unwritten, uncounted, and invisible.
        expect(indicatorVoteBacklog().buffered).toBe(2);
    });

    it('never rejects, so a database failure cannot reach the analysis path', async () => {
        const { repository } = repositoryThatFails(Number.POSITIVE_INFINITY);

        await expect(
            recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, repository),
        ).resolves.toBeUndefined();
    });
});

describe('a refused batch does not stop the ones behind it', () => {
    beforeEach(async () => {
        reporting.warn.mockClear();
        await flushIndicatorVoteBacklog(undefined, {
            record: async () => undefined,
        } as unknown as IndicatorVoteRepository);
    });

    it('writes the batches behind a refused one and re-queues only that one', async () => {
        // **This is the finding.** The loop stopped at the first failure, so one
        // batch the database refused blocked everything behind it on every flush,
        // for ever. With two markets the buffer interleaves them, so one market's
        // bad batch kept the other's votes unwritten — a hole in the sample the
        // per-indicator hit rate is computed from, which is what this buffer exists
        // to prevent.
        //
        // Safe to continue because the upsert is timestamp-guarded, so a batch
        // written out of order can only move its rows forward.
        const down = {
            record: vi.fn(async () => {
                throw new Error('down');
            }),
        } as unknown as IndicatorVoteRepository;

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, down);
        await recordIndicatorVotes(analysis(), 'ETHUSDT', reporting, down);
        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, down);

        expect(indicatorVoteBacklog().buffered).toBe(3);

        // This venue refuses the **first** batch and takes the two behind it. The
        // old loop answered zero written and left all three queued.
        let seen = 0;

        const picky = {
            record: vi.fn(async () => {
                seen += 1;

                if (seen === 1) {
                    throw new Error('constraint');
                }
            }),
        } as unknown as IndicatorVoteRepository;

        const written = await flushIndicatorVoteBacklog(reporting, picky);

        // All **three** batches are attempted — the refused one first, and the two
        // behind it after it, which is the whole point. Only the refused one goes
        // back. The old loop answered one attempt, zero written and three queued,
        // on this exact input.
        //
        // Asserted on batch calls rather than on `written`, because `written`
        // counts entries and pinning its exact value would fix how many indicators
        // the fixture happens to produce.
        expect(seen).toBe(3);
        expect(written).toBeGreaterThan(0);
        expect(indicatorVoteBacklog().buffered).toBe(1);
    });

    it('gives up on a batch that keeps failing, so it cannot evict the ones that would write', async () => {
        const alwaysRefused = {
            record: vi.fn(async () => {
                throw new Error('constraint');
            }),
        } as unknown as IndicatorVoteRepository;

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, alwaysRefused);

        expect(indicatorVoteBacklog().buffered).toBe(1);

        for (let round = 0; round < 8; round += 1) {
            await flushIndicatorVoteBacklog(reporting, alwaysRefused);
        }

        // A re-queued batch becomes the newest in a buffer that drops its oldest,
        // so a batch retried for ever would sit there protecting itself while the
        // observations the hit rate is computed from were dropped.
        expect(indicatorVoteBacklog().buffered).toBe(0);
        expect(
            reporting.warn.mock.calls.some(
                (call) => call[0]?.event === 'indicator_vote_batch_given_up',
            ),
        ).toBe(true);
    });
});
