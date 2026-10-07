import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Before the service module is imported below: its spool is built at import
// time from this configuration, so the environment has to be in place first —
// enabled, and pointed at a directory the test owns and deletes.
const spoolDir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'strategy-decision-spool-'));

    process.env.WRITE_SPOOL_ENABLED = 'true';
    process.env.WRITE_SPOOL_DIR = dir;

    return dir;
});

const spoolPath = join(spoolDir, 'strategy_decision.jsonl');

afterAll(() => {
    rmSync(spoolDir, { recursive: true, force: true });
});

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

function controlledRepository(): {
    refuse(): void;
    accept(capture: (entry: DecisionEntry) => void): void;
    writes(): number;
} {
    let writes = 0;
    let record: (entry: DecisionEntry) => Promise<void> = async () => {
        throw new Error('connection terminated');
    };

    vi.spyOn(decisionLog, 'getDecisionLogRepository').mockReturnValue({
        record: vi.fn(async (entry: DecisionEntry) => {
            await record(entry);
            writes += 1;
        }),
    } as unknown as DecisionLogRepository);

    return {
        refuse(): void {
            record = async (): Promise<void> => {
                throw new Error('connection terminated');
            };
        },
        accept(capture: (entry: DecisionEntry) => void): void {
            record = async (written: DecisionEntry): Promise<void> => {
                capture(written);
            };
        },
        writes: () => writes,
    };
}

const succeedingRecord = vi.fn(async () => undefined);

const succeeding = {
    record: succeedingRecord,
} as unknown as DecisionLogRepository;

describe('strategy decision write spool', () => {
    // Both queues are module-level, exactly as in production, and carry
    // between tests. Draining them with a venue that always succeeds gives
    // every test a known-empty starting point, which is what lets the counts
    // below be exact instead of relative.
    beforeEach(async () => {
        reporting.warn.mockClear();
        succeedingRecord.mockClear();
        resetStrategyDecisionWriteFailures();
        await flushStrategyDecisionBacklog(undefined, succeeding);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('parks a refused row on disk, not in the memory buffer', async () => {
        versionRepository();
        const venue = controlledRepository();
        venue.refuse();

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        const state = strategyDecisionBacklog();

        expect(state.spooled).toBe(1);
        expect(state.buffered).toBe(0);

        // The journal is what a promotion has to be audited against: the row
        // is outside the process before the call returns, so a crash during a
        // database outage is not an afternoon of decisions nobody can see.
        expect(readFileSync(spoolPath, 'utf8')).toContain('"BTCUSDT"');
    });

    it('writes the spooled row on the next flush, exactly once, with the version it was made under', async () => {
        versionRepository(42);
        const venue = controlledRepository();

        venue.refuse();
        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        const captured: DecisionEntry[] = [];

        venue.accept((written) => captured.push(written));

        expect(await flushStrategyDecisionBacklog(reporting)).toBe(1);
        expect(strategyDecisionBacklog().spooled).toBe(0);
        expect(readFileSync(spoolPath, 'utf8')).toBe('');
        expect(captured[0]?.strategyVersionId).toBe(42);
        expect(captured[0]?.symbol).toBe('BTCUSDT');

        await flushStrategyDecisionBacklog(reporting);

        expect(venue.writes()).toBe(1);
    });

    it('spools the row even when the version could not be resolved', async () => {
        // `resolveActive` is a database round trip, so a database that is down
        // fails it before the insert is ever reached. The cycle still happened,
        // and the honest row is one with a null version, spooled like any
        // other — not no row at all.
        vi.spyOn(strategyVersion, 'getStrategyVersionRepository').mockReturnValue({
            resolveActive: vi.fn(async () => {
                throw new Error('connection terminated');
            }),
        } as unknown as ReturnType<typeof strategyVersion.getStrategyVersionRepository>);

        const venue = controlledRepository();
        venue.refuse();

        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        expect(strategyDecisionBacklog().spooled).toBe(1);

        const captured: DecisionEntry[] = [];

        venue.accept((written) => captured.push(written));
        await flushStrategyDecisionBacklog(reporting);

        expect(captured[0]?.strategyVersionId).toBeNull();
    });

    it('gives up on a spooled row the database refuses for good', async () => {
        versionRepository();
        const venue = controlledRepository();

        venue.refuse();
        await recordStrategyDecisions(
            { symbol: 'BTCUSDT', published: resolved() },
            reporting,
        );

        for (let round = 0; round < 6; round += 1) {
            await flushStrategyDecisionBacklog(reporting);
        }

        // The bound retries that exist for the memory buffer apply to the file
        // too: a row nothing will ever take must not sit at the head of the
        // file for ever, replayed on every boot.
        expect(strategyDecisionBacklog().spooled).toBe(0);
        expect(
            reporting.warn.mock.calls.some(
                (call) => call[0]?.event === 'strategy_decision_spool_entry_given_up',
            ),
        ).toBe(true);
    });
});
