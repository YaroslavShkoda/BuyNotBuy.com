import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketAnalysis } from '../../types/analysis.js';
import {
    flushIndicatorVoteBacklog,
    indicatorVoteBacklog,
    recordIndicatorVotes,
} from './indicator-performance.service.js';
import type { IndicatorVoteRepository } from './indicator-vote.repository.js';

// Before the service module is imported below: its spool is built at import
// time from this configuration, so the environment has to be in place first —
// enabled, and pointed at a directory the test owns and deletes.
const spoolDir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'indicator-vote-spool-'));

    process.env.WRITE_SPOOL_ENABLED = 'true';
    process.env.WRITE_SPOOL_DIR = dir;

    return dir;
});

const spoolPath = join(spoolDir, 'indicator_vote.jsonl');

afterAll(() => {
    rmSync(spoolDir, { recursive: true, force: true });
});

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

function repositoryThatFails(times: number): IndicatorVoteRepository {
    let attempts = 0;

    return {
        record: vi.fn(async (votes: unknown[]) => {
            attempts += 1;

            if (attempts <= times) {
                throw new Error('connection terminated');
            }
        }),
        list: vi.fn(),
        listUnsettled: vi.fn(),
        settle: vi.fn(),
        count: vi.fn(),
        schemaVersion: vi.fn(),
        durabilitySettings: vi.fn(),
    } as unknown as IndicatorVoteRepository;
}

const succeedingRecord = vi.fn(async () => undefined);

const succeeding = {
    record: succeedingRecord,
} as unknown as IndicatorVoteRepository;

describe('indicator vote write spool', () => {
    // Both queues are module-level, exactly as in production, and carry
    // between tests. Draining them with a venue that always succeeds gives
    // every test a known-empty starting point, which is what lets the counts
    // below be exact instead of relative.
    beforeEach(async () => {
        reporting.warn.mockClear();
        succeedingRecord.mockClear();
        await flushIndicatorVoteBacklog(undefined, succeeding);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('parks a refused batch on disk, not in the memory buffer', async () => {
        await recordIndicatorVotes(
            analysis(),
            'BTCUSDT',
            reporting,
            repositoryThatFails(Number.POSITIVE_INFINITY),
        );

        const state = indicatorVoteBacklog();

        expect(state.spooled).toBe(1);
        expect(state.buffered).toBe(0);

        // The batch is on disk before the call returns — a crash here must
        // not take the observations the hit rates are computed from with it.
        expect(readFileSync(spoolPath, 'utf8')).toContain('"BTCUSDT"');
    });

    it('writes the spooled batch on the next flush, exactly once, and empties the file', async () => {
        const failing = repositoryThatFails(Number.POSITIVE_INFINITY);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, failing);

        const succeedingRecord = repositoryThatFails(0);

        expect(await flushIndicatorVoteBacklog(reporting, succeedingRecord)).toBe(2);
        expect(indicatorVoteBacklog().spooled).toBe(0);
        expect(readFileSync(spoolPath, 'utf8')).toBe('');

        // The replay is idempotent by construction — the timestamp-guarded
        // upsert folds it — but the flush itself must not invite it twice.
        await flushIndicatorVoteBacklog(reporting, succeedingRecord);

        expect(succeedingRecord.record).toHaveBeenCalledTimes(1);
    });

    it('gives up on a spooled batch the database refuses for good', async () => {
        const failing = repositoryThatFails(Number.POSITIVE_INFINITY);

        await recordIndicatorVotes(analysis(), 'BTCUSDT', reporting, failing);

        for (let round = 0; round < 6; round += 1) {
            await flushIndicatorVoteBacklog(reporting, failing);
        }

        // The bound retries that exist for the memory buffer apply to the file
        // too: a batch nothing will ever take must not sit at the head of the
        // file for ever, replayed on every boot.
        expect(indicatorVoteBacklog().spooled).toBe(0);
        expect(
            reporting.warn.mock.calls.some(
                (call) => call[0]?.event === 'indicator_vote_spool_batch_given_up',
            ),
        ).toBe(true);
    });
});
