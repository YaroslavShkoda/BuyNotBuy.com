import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushIndicatorVoteBacklog,
    indicatorVoteBacklog,
    recordIndicatorVotes,
} from './indicator-performance.service.js';

import type { MarketAnalysis } from '../../types/analysis.js';
import type { IndicatorVoteRepository } from './indicator-vote.repository.js';

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
        await flushIndicatorVoteBacklog(undefined, {
            record: async () => undefined,
        } as unknown as IndicatorVoteRepository);
    });

    it('holds a vote that could not be written instead of losing it', async () => {
        const { repository } = repositoryThatFails(1);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', undefined, repository);

        // A vote lost to a full connection pool is not a neutral vote, it is a
        // missing observation — and the per-indicator hit rate is computed
        // from exactly this table.
        expect(indicatorVoteBacklog().buffered).toBe(1);
    });

    it('writes the held votes on the next flush', async () => {
        const { repository, written } = repositoryThatFails(1);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', undefined, repository);
        await flushIndicatorVoteBacklog(undefined, repository);

        expect(written()).toBe(2);
        expect(indicatorVoteBacklog().buffered).toBe(0);
    });

    it('re-queues the whole tail when a flush fails part way', async () => {
        const { repository } = repositoryThatFails(Number.POSITIVE_INFINITY);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', undefined, repository);
        await recordIndicatorVotes(analysis(), 'BTCUSDT', undefined, repository);

        expect(indicatorVoteBacklog().buffered).toBe(2);

        await flushIndicatorVoteBacklog(undefined, repository);

        // Re-queueing only the batch that failed would discard everything after
        // it — unwritten, uncounted, and invisible.
        expect(indicatorVoteBacklog().buffered).toBe(2);
    });

    it('never rejects, so a database failure cannot reach the analysis path', async () => {
        const { repository } = repositoryThatFails(Number.POSITIVE_INFINITY);

        await expect(
            recordIndicatorVotes(analysis(), 'BTCUSDT', undefined, repository),
        ).resolves.toBeUndefined();
    });
});
