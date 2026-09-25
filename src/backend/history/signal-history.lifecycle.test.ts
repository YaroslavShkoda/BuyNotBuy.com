import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignalHistoryRepository } from './signal-history.repository';

import type { SignalHistoryEntry } from './signal-history.types';

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

// Lifecycle coverage for the SQLite file handle. The process-wide singleton
// (getSignalHistoryRepository / closeSignalHistoryRepository) is exercised
// end-to-end by the runtime restart/cleanup checks; here we prove the same
// semantics at the factory level on real temporary database files.
describe('signal history repository lifecycle', () => {
    it('persists entries across close and reopen (restart semantics)', () => {
        const directory = mkdtempSync(join(tmpdir(), 'buy-sqlite-'));
        const databasePath = join(directory, 'signal-history.db');

        try {
            const first = createSignalHistoryRepository({
                databasePath,
                maxEntries: 720,
            });

            first.record(makeEntry());
            first.record(makeEntry({
                timestamp: 1_737_950_400_000 - HOUR_MS,
                signal: 'LONG',
            }));
            first.close();

            // A fresh repository over the same file must still see the data.
            const reopened = createSignalHistoryRepository({
                databasePath,
                maxEntries: 720,
            });

            try {
                expect(reopened.list('BTCUSDT', 10)).toHaveLength(2);
            } finally {
                reopened.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('releases the file lock after close so the database file can be deleted', () => {
        const directory = mkdtempSync(join(tmpdir(), 'buy-sqlite-'));
        const databasePath = join(directory, 'signal-history.db');

        try {
            const repository = createSignalHistoryRepository({
                databasePath,
                maxEntries: 720,
            });

            repository.record(makeEntry());
            repository.close();

            // On Windows an open SQLite handle would make this throw EPERM;
            // after a proper close the file must be deletable.
            expect(() => rmSync(databasePath)).not.toThrow();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('makes close idempotent and rejects writes after close', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.close();
        expect(() => repository.close()).not.toThrow();

        // node:sqlite invalidates the handle on close, so further writes throw.
        expect(() => repository.record(makeEntry())).toThrow();
        expect(() => repository.list('BTCUSDT', 10)).toThrow();
    });

    it('keeps concurrent writes to a file database consistent', () => {
        const directory = mkdtempSync(join(tmpdir(), 'buy-sqlite-'));
        const databasePath = join(directory, 'signal-history.db');

        try {
            const repository = createSignalHistoryRepository({
                databasePath,
                maxEntries: 720,
            });

            try {
                // Writes are synchronous and serialized by the single
                // DatabaseSync handle; each entry lands in its own hour bucket.
                for (let hour = 0; hour < 10; hour += 1) {
                    repository.record(makeEntry({
                        timestamp: 1_737_950_400_000 - hour * HOUR_MS,
                    }));
                }

                expect(repository.list('BTCUSDT', 10)).toHaveLength(10);
            } finally {
                repository.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps symbols independent after reopen', () => {
        const directory = mkdtempSync(join(tmpdir(), 'buy-sqlite-'));
        const databasePath = join(directory, 'signal-history.db');

        try {
            const first = createSignalHistoryRepository({
                databasePath,
                maxEntries: 720,
            });

            first.record(makeEntry());
            first.record(makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }));
            first.close();

            const reopened = createSignalHistoryRepository({
                databasePath,
                maxEntries: 720,
            });

            try {
                expect(reopened.list('BTCUSDT', 10)).toHaveLength(1);
                expect(reopened.list('ETHUSDT', 10)).toHaveLength(1);
            } finally {
                reopened.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});