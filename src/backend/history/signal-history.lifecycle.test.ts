import { describe, expect, it } from 'vitest';

import { createSignalHistoryRepository } from './signal-history.repository.js';

import type { SignalHistoryEntry } from './signal-history.types.js';

const HOUR_MS = 3_600_000;

function makeEntry(overrides: Partial<SignalHistoryEntry> = {}): SignalHistoryEntry {
    return {
        timestamp: 1_737_950_400_000,
        symbol: 'BTCUSDT',
        signal: 'SHORT',
        consensus: 67,
        price: 100_000,
        ...overrides,
    };
}

// Lifecycle coverage for the repository factory over a real database.
//
// This file used to cover the SQLite file handle: the handle had to be closed
// before anything else could read the file, and Windows refused to delete a
// file that was still open. None of that survives the move to PostgreSQL.
// There is no handle to close and no per-repository resource at all — the
// connection pool is process-wide and outlives every repository instance, so
// "close" and "writes throw after close" have no meaning here.
//
// What is left is the part a restart actually depends on: a row committed by
// one instance is there for the next one, two instances sharing a pool do not
// blur each other's symbols, and writes that overlap in time all land. The
// concurrency case is worth more now than it was: a single serialized
// `DatabaseSync` handle could never produce genuinely overlapping writes,
// whereas the pool hands each one its own connection and does.
describe('signal history repository lifecycle', () => {
    it('sees rows committed by an earlier repository instance (restart semantics)', async () => {
        const beforeRestart = createSignalHistoryRepository({ maxEntries: 720 });

        await beforeRestart.record(makeEntry());
        await beforeRestart.record(makeEntry({
            timestamp: 1_737_950_400_000 - HOUR_MS,
            signal: 'LONG',
        }));

        // A service restart builds its repository again over the same
        // database. Nothing is carried in memory, so every row the new
        // instance shows came back out of the database.
        const afterRestart = createSignalHistoryRepository({ maxEntries: 720 });

        expect(await afterRestart.list('BTCUSDT', 10)).toHaveLength(2);
    });

    it('keeps symbols independent across repository instances', async () => {
        const first = createSignalHistoryRepository({ maxEntries: 720 });

        await first.record(makeEntry());
        await first.record(makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }));

        const second = createSignalHistoryRepository({ maxEntries: 720 });

        expect(await second.list('BTCUSDT', 10)).toEqual([makeEntry()]);
        expect(await second.list('ETHUSDT', 10)).toEqual([
            makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }),
        ]);
    });

    it('keeps overlapping writes consistent', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        // Started together rather than one after another, so the transactions
        // really do overlap across pooled connections. Each entry lands in its
        // own hour bucket, so all ten rows have to survive.
        const writes: Array<Promise<void>> = [];

        for (let hour = 0; hour < 10; hour += 1) {
            writes.push(repository.record(makeEntry({
                timestamp: 1_737_950_400_000 - hour * HOUR_MS,
            })));
        }

        await Promise.all(writes);

        const entries = await repository.list('BTCUSDT', 20);

        expect(entries).toHaveLength(10);

        // Every hour must be present exactly once, not merely "ten rows
        // somehow": the hourly bucket is the primary key, so a lost update
        // would show up here as a gap rather than as a wrong count.
        expect(new Set(entries.map((entry) => entry.timestamp)).size).toBe(10);
    });
});
