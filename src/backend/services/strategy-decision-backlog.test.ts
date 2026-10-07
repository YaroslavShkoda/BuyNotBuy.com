import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as strategyVersion from '../analysis/strategy-version.repository.js';
import type { DecisionEntry, DecisionLogRepository } from '../strategies/decision-log.repository.js';
import * as decisionLog from '../strategies/decision-log.repository.js';
import type { ResolvedSignal } from '../strategies/registry.js';
import {
    flushStrategyDecisionBacklog,
    recordStrategyDecisions,
    resetStrategyDecisionWriteFailures,
    strategyDecisionBacklog,
} from './analysis.persistence.js';

/**
 * The one logger this file needs, and named — for the same reason the vote
 * backlog test names its own: a refused write is reported, and a test that
 * cannot hear the report cannot check it.
 */
const reporting = { warn: vi.fn() };

function resolved(over: Partial<ResolvedSignal> = {}): ResolvedSignal {
    return {
        published: { direction: 'LONG', confidence: 61 },
        publishedBy: 'consensus-primary',
        primaryDecision: { direction: 'LONG', confidence: 61 },
        fallbackKey: 'donchian-20',
        fallbackDecision: { direction: 'SHORT', confidence: 40 },
        suppressed: true,
        ...over,
    } as unknown as ResolvedSignal;
}

/** A version resolution that always answers, so the row carries a real id. */
function versionRepository(id = 7): void {
    vi.spyOn(strategyVersion, 'getStrategyVersionRepository').mockReturnValue({
        resolveActive: vi.fn(async () => ({
            id,
            name: 'auto-test',
            description: '',
            configHash: 'test',
            createdAt: 0,
        })),
    } as unknown as ReturnType<typeof strategyVersion.getStrategyVersionRepository>);
}

function decisionRepositoryThatFails(times: number): {
    repository: DecisionLogRepository;
    attempts: () => number;
    written: () => number;
    rows: () => DecisionEntry[];
} {
    let attempts = 0;
    let written = 0;
    const rows: DecisionEntry[] = [];

    vi.spyOn(decisionLog, 'getDecisionLogRepository').mockReturnValue({
        record: vi.fn(async (entry: DecisionEntry) => {
            attempts += 1;

            if (attempts <= times) {
                throw new Error('connection terminated');
            }

            written += 1;
            rows.push(entry);
        }),
    } as unknown as DecisionLogRepository);

    return {
        repository: decisionLog.getDecisionLogRepository(),
        attempts: () => attempts,
        written: () => written,
        rows: () => rows,
    };
}

const succeedingRecord = vi.fn(async () => undefined);

const succeeding = {
    record: succeedingRecord,
} as unknown as DecisionLogRepository;

describe('strategy decision write backlog', () => {
    // The backlog is module-level, exactly as it is in production, so it
    // carries between tests. Draining it with a repository that always
    // succeeds gives every test a known-empty starting point, which is what
    // lets the counts below be exact instead of relative.
    beforeEach(async () => {
        reporting.warn.mockClear();
        succeedingRecord.mockClear();
        resetStrategyDecisionWriteFailures();
        await flushStrategyDecisionBacklog(undefined, succeeding);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('holds a decision that could not be written instead of losing it', async () => {
        versionRepository();
        decisionRepositoryThatFails(1);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        // The journal is the evidence base the promotion decision is made
        // from: a row lost to a full connection pool is a missing cycle, and
        // the shadow report would read the survivors as the whole sample.
        expect(strategyDecisionBacklog().buffered).toBe(1);
    });

    it('and says so, on the logger the analysis path already passes', async () => {
        versionRepository();
        decisionRepositoryThatFails(Number.POSITIVE_INFINITY);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        expect(reporting.warn).toHaveBeenCalledTimes(1);

        const [context, message] = reporting.warn.mock.calls[0] as [
            Record<string, unknown>,
            string,
        ];

        expect(message).toBe('strategy_decision_record_failed');
        expect(context.event).toBe('strategy_decision_record_failed');
        expect(context.market).toBe('BTCUSDT');
        expect(context.buffered).toBe(1);
    });

    it('writes the held decision on the next flush, exactly once', async () => {
        versionRepository();
        const { repository, written } = decisionRepositoryThatFails(1);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );
        await flushStrategyDecisionBacklog(undefined, repository);

        expect(written()).toBe(1);
        expect(strategyDecisionBacklog().buffered).toBe(0);

        // A second flush over an empty backlog is a no-op: the replay of a
        // confirmed write is how a cycle gets counted twice.
        await flushStrategyDecisionBacklog(undefined, repository);

        expect(written()).toBe(1);
    });

    it('keeps the version the decision was actually made under', async () => {
        versionRepository(42);
        const { repository, rows } = decisionRepositoryThatFails(1);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );
        await flushStrategyDecisionBacklog(undefined, repository);

        expect(rows()[0]?.strategyVersionId).toBe(42);
    });

    it('buffers the row even when the version could not be resolved, with the version left unknown', async () => {
        // `resolveActive` is a database round trip, so a database that is down
        // fails it before the insert is ever reached. The cycle still happened,
        // and the honest row is one with a null version — the state the schema
        // and the evidence gate already hold — not no row at all.
        vi.spyOn(strategyVersion, 'getStrategyVersionRepository').mockReturnValue({
            resolveActive: vi.fn(async () => {
                throw new Error('connection terminated');
            }),
        } as unknown as ReturnType<typeof strategyVersion.getStrategyVersionRepository>);

        const { repository, rows } = decisionRepositoryThatFails(1);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        expect(strategyDecisionBacklog().buffered).toBe(1);

        await flushStrategyDecisionBacklog(undefined, repository);

        expect(rows()[0]?.strategyVersionId).toBeNull();
    });

    it('never rejects, so a database failure cannot reach the analysis path', async () => {
        versionRepository();
        decisionRepositoryThatFails(Number.POSITIVE_INFINITY);

        await expect(
            recordStrategyDecisions(
                { symbol: 'BTCUSDT', published: resolved() },
                reporting,
            ),
        ).resolves.toBeUndefined();
    });

    it('re-queues the whole tail when a flush fails part way', async () => {
        versionRepository();
        const { repository } = decisionRepositoryThatFails(Number.POSITIVE_INFINITY);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );
        await recordStrategyDecisions(
            { symbol: 'ETHUSDT', published: resolved() },
            reporting,
        );

        expect(strategyDecisionBacklog().buffered).toBe(2);

        await flushStrategyDecisionBacklog(undefined, repository);

        // Re-queueing only the row that failed would discard everything after
        // it — unwritten, uncounted, and invisible.
        expect(strategyDecisionBacklog().buffered).toBe(2);
    });
});

describe('a refused row does not stop the ones behind it', () => {
    beforeEach(async () => {
        reporting.warn.mockClear();
        succeedingRecord.mockClear();
        resetStrategyDecisionWriteFailures();
        await flushStrategyDecisionBacklog(undefined, succeeding);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('writes the rows behind a refused one and re-queues only that one', async () => {
        // The loop stops at the second consecutive failure, so one row the
        // database refuses for its own reasons must not block the markets
        // behind it: with two markets the buffer interleaves them, and one
        // market's bad row would otherwise keep the other's cycles unwritten
        // on every flush, for ever.
        versionRepository();
        // The failing repository is what parks three rows in the backlog; the
        // flush below runs against one that refuses exactly the first.
        decisionRepositoryThatFails(Number.POSITIVE_INFINITY);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );
        await recordStrategyDecisions(
            { symbol: 'ETHUSDT', published: resolved() },
            reporting,
        );
        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        expect(strategyDecisionBacklog().buffered).toBe(3);

        // This venue refuses the **first** row and takes the two behind it.
        let seen = 0;

        const picky = {
            record: vi.fn(async () => {
                seen += 1;

                if (seen === 1) {
                    throw new Error('constraint');
                }
            }),
        } as unknown as DecisionLogRepository;

        const written = await flushStrategyDecisionBacklog(reporting, picky);

        expect(seen).toBe(3);
        expect(written).toBe(2);
        expect(strategyDecisionBacklog().buffered).toBe(1);
    });

    it('gives up on a row that keeps failing, so it cannot evict the ones that would write', async () => {
        versionRepository();
        const { repository } = decisionRepositoryThatFails(Number.POSITIVE_INFINITY);

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        expect(strategyDecisionBacklog().buffered).toBe(1);

        for (let round = 0; round < 8; round += 1) {
            await flushStrategyDecisionBacklog(reporting, repository);
        }

        // A re-queued row becomes the newest in a buffer that drops its oldest,
        // so a row retried for ever would sit there protecting itself while the
        // cycles the promotion decision rests on were dropped.
        expect(strategyDecisionBacklog().buffered).toBe(0);
        expect(
            reporting.warn.mock.calls.some(
                (call) => call[0]?.event === 'strategy_decision_entry_given_up',
            ),
        ).toBe(true);
    });
});
