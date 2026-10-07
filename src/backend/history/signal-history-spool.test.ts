import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repository from './signal-history.repository.js';
import {
    flushSignalHistoryBacklog,
    recordSignalHistory,
    signalHistoryBacklog,
} from './signal-history.service.js';
import type { SignalHistoryEntry } from './signal-history.types.js';

// Before the service module is imported below: its spool is built at import
// time from this configuration, so the environment has to be in place first —
// enabled, and pointed at a directory the test owns and deletes.
const spoolDir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'signal-history-spool-'));

    process.env.WRITE_SPOOL_ENABLED = 'true';
    process.env.WRITE_SPOOL_DIR = dir;

    return dir;
});

const spoolPath = join(spoolDir, 'signal_history.jsonl');

afterAll(() => {
    rmSync(spoolDir, { recursive: true, force: true });
});

const reporting = { warn: vi.fn() };

function entry(symbol: string, timestamp = 1_700_000_000_000): SignalHistoryEntry {
    return { timestamp, symbol, signal: 'LONG', consensus: 61, price: 100_000 };
}

/**
 * What the (single, getter-hidden) history venue is currently doing.
 *
 * `flushSignalHistoryBacklog` takes no repository — unlike its vote and
 * decision siblings — so every test reaches the venue through the module
 * getter, and the getter hands out whatever `currentRecord` says this test
 * needs.
 */
const captured: SignalHistoryEntry[] = [];
const writes = { count: 0 };
let currentRecord: (entry: SignalHistoryEntry) => Promise<void> = async () => undefined;

function useRepository(record: (entry: SignalHistoryEntry) => Promise<void>): void {
    vi.spyOn(repository, 'getSignalHistoryRepository').mockReturnValue({
        record,
    } as unknown as ReturnType<typeof repository.getSignalHistoryRepository>);
}

function refuse(): void {
    currentRecord = async (): Promise<void> => {
        throw new Error('connection terminated');
    };

    useRepository((entry) => currentRecord(entry));
}

function accept(): void {
    currentRecord = async (written: SignalHistoryEntry): Promise<void> => {
        captured.push(written);
        writes.count += 1;
    };

    useRepository((entry) => currentRecord(entry));
}

describe('signal history write spool', () => {
    // Both queues are module-level, exactly as in production, and carry
    // between tests. Draining them with a venue that always succeeds gives
    // every test a known-empty starting point, which is what lets the counts
    // below be exact instead of relative.
    beforeEach(async () => {
        reporting.warn.mockClear();
        captured.length = 0;
        writes.count = 0;

        // A succeeding venue that captures nothing: the drain here only
        // empties what a previous test left behind, and its writes must not
        // land in `captured`, which belongs to the test below.
        currentRecord = async (): Promise<void> => undefined;
        useRepository((entry) => currentRecord(entry));

        await flushSignalHistoryBacklog(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('parks a refused entry on disk, not in the memory buffer', async () => {
        refuse();

        await recordSignalHistory(entry('BTCUSDT'), reporting);

        const state = signalHistoryBacklog();

        expect(state.spooled).toBe(1);
        expect(state.buffered).toBe(0);

        // The whole point of the file: the entry exists outside the process.
        expect(readFileSync(spoolPath, 'utf8')).toContain('"BTCUSDT"');
    });

    it('writes the spooled entry on the next flush, exactly once, and empties the file', async () => {
        refuse();
        await recordSignalHistory(entry('BTCUSDT'), reporting);

        expect(signalHistoryBacklog().spooled).toBe(1);

        accept();

        expect(await flushSignalHistoryBacklog(reporting)).toBe(1);
        expect(signalHistoryBacklog().spooled).toBe(0);
        expect(readFileSync(spoolPath, 'utf8')).toBe('');

        // The entry the flush wrote is the entry that was spooled, series
        // resolved — not a re-derivation of it.
        expect(captured).toEqual([
            { ...entry('BTCUSDT'), provider: expect.any(String), interval: expect.any(String) },
        ]);

        await flushSignalHistoryBacklog(reporting);

        expect(writes.count).toBe(1);
    });

    it('says what it parked, on the logger the caller already passed', async () => {
        refuse();

        await recordSignalHistory(entry('BTCUSDT'), reporting);

        expect(reporting.warn).toHaveBeenCalledTimes(1);

        const [context, message] = reporting.warn.mock.calls[0] as [
            Record<string, unknown>,
            string,
        ];

        expect(message).toBe('signal_history_record_failed');
        expect(context.spooled).toBe(1);
        expect(context.buffered).toBe(0);
    });

    it('gives up on a spooled entry the database refuses for good', async () => {
        refuse();
        await recordSignalHistory(entry('BTCUSDT'), reporting);

        for (let round = 0; round < 6; round += 1) {
            await flushSignalHistoryBacklog(reporting);
        }

        // The bound retries that exist for the memory buffer apply to the file
        // too: a row nothing will ever take must not sit at the head of the
        // file for ever, replayed on every boot.
        expect(signalHistoryBacklog().spooled).toBe(0);
        expect(
            reporting.warn.mock.calls.some(
                (call) => call[0]?.event === 'signal_history_spool_entry_given_up',
            ),
        ).toBe(true);
    });
});
