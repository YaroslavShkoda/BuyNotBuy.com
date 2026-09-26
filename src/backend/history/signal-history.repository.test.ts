import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSignalHistoryRepository, closeSignalHistoryRepository } from './signal-history.repository.js';

import type { SignalHistoryEntry } from './signal-history.types.js';

const HOUR_MS = 3_600_000;

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'signal-history-'));
    temporaryDirectories.push(directory);

    // The nested folder is what the repository creates in production, so the
    // helper creates it here too for the tests that open the file directly.
    const nested = join(directory, 'nested');
    mkdirSync(nested, { recursive: true });

    return join(nested, 'history.db');
}

function readPragma(path: string, pragma: string): string {
    const db = new DatabaseSync(path);

    try {
        const rows = db.prepare(`PRAGMA ${pragma}`).all() as unknown as Array<
            Record<string, unknown>
        >;

        return String(Object.values(rows[0] ?? {})[0]);
    } finally {
        db.close();
    }
}

afterEach(() => {
    delete process.env.HISTORY_DB_PATH;
    closeSignalHistoryRepository();

    while (temporaryDirectories.length > 0) {
        const directory = temporaryDirectories.pop();

        if (directory !== undefined) {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

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

describe('signal history repository', () => {
    it('stores and returns an entry with all fields preserved', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry());

        expect(repository.list('BTCUSDT', 10)).toEqual([
            makeEntry(),
        ]);
    });

    it('keeps a single record per hour and the newest analysis wins', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const hourStart = 1_737_950_400_000;

        repository.record(makeEntry({
            timestamp: hourStart + 10 * 60_000,
            signal: 'LONG',
            price: 99_000,
        }));

        repository.record(makeEntry({
            timestamp: hourStart + 40 * 60_000,
        }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(hourStart + 40 * 60_000);
        expect(entries[0]?.signal).toBe('SHORT');
        expect(entries[0]?.price).toBe(100_000);
    });

    it('does not overwrite a newer record with a late-arriving older snapshot', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const hourStart = 1_737_950_400_000;

        repository.record(makeEntry({
            timestamp: hourStart + 40 * 60_000,
        }));

        repository.record(makeEntry({
            timestamp: hourStart + 10 * 60_000,
            signal: 'LONG',
        }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(hourStart + 40 * 60_000);
        expect(entries[0]?.signal).toBe('SHORT');
    });

    it('returns entries newest-first across hours', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const dayStart = 1_737_936_000_000;

        repository.record(makeEntry({ timestamp: dayStart + 2 * HOUR_MS }));
        repository.record(makeEntry({ timestamp: dayStart + HOUR_MS }));
        repository.record(makeEntry({ timestamp: dayStart }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 2 * HOUR_MS,
            dayStart + HOUR_MS,
            dayStart,
        ]);
    });

    it('limits the number of returned entries to the newest ones', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const dayStart = 1_737_936_000_000;

        for (let hour = 0; hour < 5; hour += 1) {
            repository.record(makeEntry({ timestamp: dayStart + hour * HOUR_MS }));
        }

        const entries = repository.list('BTCUSDT', 2);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 4 * HOUR_MS,
            dayStart + 3 * HOUR_MS,
        ]);
    });

    it('trims retained entries down to maxEntries keeping the newest', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 3,
        });

        const dayStart = 1_737_936_000_000;

        for (let hour = 0; hour < 5; hour += 1) {
            repository.record(makeEntry({ timestamp: dayStart + hour * HOUR_MS }));
        }

        const entries = repository.list('BTCUSDT', 10);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 4 * HOUR_MS,
            dayStart + 3 * HOUR_MS,
            dayStart + 2 * HOUR_MS,
        ]);
    });

    it('keeps symbols independent', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry());
        repository.record(makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }));

        expect(repository.list('BTCUSDT', 10)).toEqual([makeEntry()]);
        expect(repository.list('ETHUSDT', 10)).toEqual([
            makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }),
        ]);
    });

    it('rounds consensus to an integer', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry({ consensus: 66.6 }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries[0]?.consensus).toBe(67);
    });

    it('returns an empty list for unknown symbol', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        expect(repository.list('BTCUSDT', 10)).toEqual([]);
    });
});

describe('signal history schema', () => {
    it('records its version in the database file', () => {
        const repository = createSignalHistoryRepository({
            databasePath: temporaryDatabasePath(),
            maxEntries: 720,
        });

        // A version number stored in the file is what makes an upgrade
        // distinguishable from a fresh install.
        expect(repository.schemaVersion()).toBe(1);

        repository.close();
    });

    it('keeps the version across a reopen', () => {
        const path = temporaryDatabasePath();

        createSignalHistoryRepository({ databasePath: path, maxEntries: 720 })
            .close();

        const reopened = createSignalHistoryRepository({
            databasePath: path,
            maxEntries: 720,
        });

        expect(reopened.schemaVersion()).toBe(1);

        reopened.close();
    });

    it('refuses to open a database from a newer build', () => {
        const path = temporaryDatabasePath();

        const db = new DatabaseSync(path);
        db.exec('PRAGMA user_version = 99');
        db.close();

        // An older binary writing into a newer file would produce a schema it
        // cannot read back. Refusing to start is recoverable.
        expect(() =>
            createSignalHistoryRepository({
                databasePath: path,
                maxEntries: 720,
            }),
        ).toThrow(/version 99/);
    });

    it('creates the table on a database that has never been written to', () => {
        const path = temporaryDatabasePath();

        const repository = createSignalHistoryRepository({
            databasePath: path,
            maxEntries: 720,
        });

        repository.record(makeEntry());

        expect(repository.list('BTCUSDT', 10)).toHaveLength(1);

        repository.close();
    });

    it('finds an unusable database at startup, not at the first request', async () => {
        // The repository is a lazy singleton for testability, so without an
        // explicit startup check a service would boot, report itself healthy,
        // and then fail every market request.
        const path = temporaryDatabasePath();
        const db = new DatabaseSync(path);
        db.exec('PRAGMA user_version = 99');
        db.close();

        process.env.HISTORY_DB_PATH = path;
        vi.resetModules();

        const module = await import('./signal-history.repository');

        expect(() => module.assertSignalHistorySchemaReady()).toThrow(
            /version 99/,
        );

        delete process.env.HISTORY_DB_PATH;
        vi.resetModules();
    });
});

describe('signal history durability', () => {
    it('uses write-ahead logging for a file database', () => {
        const path = temporaryDatabasePath();

        const repository = createSignalHistoryRepository({
            databasePath: path,
            maxEntries: 720,
        });
        repository.close();

        // WAL lets a reader work while a writer holds the database, which a
        // rollback journal cannot do.
        expect(readPragma(path, 'journal_mode').toLowerCase()).toBe('wal');
    });

    it('does not fsync on every single commit', () => {
        const repository = createSignalHistoryRepository({
            databasePath: temporaryDatabasePath(),
            maxEntries: 720,
        });

        // NORMAL still fsyncs at checkpoints, so the file cannot be
        // corrupted; it just stops fsyncing on each commit. The setting is
        // per-connection, so it has to be read from this one.
        expect(repository.durabilitySettings().synchronous).toBe('1');

        repository.close();
    });

    it('works on a memory database, where WAL does not apply', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry());

        expect(repository.list('BTCUSDT', 10)).toHaveLength(1);
        expect(repository.schemaVersion()).toBe(1);

        repository.close();
    });

    it('keeps the data readable by a separate connection while a writer holds it', () => {
        const path = temporaryDatabasePath();

        const repository = createSignalHistoryRepository({
            databasePath: path,
            maxEntries: 720,
        });
        repository.record(makeEntry());

        // With a rollback journal this would be refused; that is the point of
        // turning WAL on for a service that is read and written.
        const reader = new DatabaseSync(path);
        const rows = reader
            .prepare('SELECT COUNT(*) AS total FROM signal_history')
            .all() as unknown as Array<{ total: number }>;

        expect(rows[0]?.total).toBe(1);

        reader.close();
        repository.close();
    });
    it('does not keep a handle open when the file cannot be initialised', () => {
        const path = temporaryDatabasePath();

        writeFileSync(path, 'this is not a database');

        expect(() =>
            createSignalHistoryRepository({ databasePath: path, maxEntries: 720 }),
        ).toThrow();

        // If the constructor leaves the connection open, a readiness probe
        // that runs every few seconds leaks one per probe. Removing the file
        // is the direct check: Windows refuses while a handle is still open.
        expect(() => rmSync(path, { force: true })).not.toThrow();
    });
});

describe('signal history pagination', () => {
    const START = 1_737_936_000_000;

    function filledRepository(hours: number) {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        for (let hour = 0; hour < hours; hour += 1) {
            repository.record(
                makeEntry({
                    timestamp: START + hour * HOUR_MS,
                    price: 100_000 + hour,
                }),
            );
        }

        return repository;
    }

    it('returns the newest records first', () => {
        const repository = filledRepository(10);

        const page = repository.list('BTCUSDT', 3);

        expect(page.map((entry) => entry.price)).toEqual([100_009, 100_008, 100_007]);

        repository.close();
    });

    it('continues strictly below the last record of the previous page', () => {
        const repository = filledRepository(10);

        const first = repository.list('BTCUSDT', 4);
        const boundary = Math.floor(first.at(-1)!.timestamp / HOUR_MS);
        const second = repository.list('BTCUSDT', 4, boundary);

        expect(second.map((entry) => entry.price)).toEqual([
            100_005, 100_004, 100_003, 100_002,
        ]);

        // The last record of one page is the boundary, so consecutive pages
        // must not overlap. A duplicate here would be counted as a second
        // hour in the stability summary.
        for (const entry of second) {
            expect(Math.floor(entry.timestamp / HOUR_MS)).toBeLessThan(boundary);
        }

        repository.close();
    });

    it('returns nothing past the oldest record', () => {
        const repository = filledRepository(3);

        const page = repository.list('BTCUSDT', 4);
        const boundary = Math.floor(page.at(-1)!.timestamp / HOUR_MS);

        // An empty page is how the end of the record announces itself.
        expect(repository.list('BTCUSDT', 4, boundary)).toEqual([]);

        repository.close();
    });

    it('returns nothing for a boundary before the whole record', () => {
        const repository = filledRepository(3);

        expect(repository.list('BTCUSDT', 4, 0)).toEqual([]);

        repository.close();
    });

    it('reaches every record exactly once when walked page by page', () => {
        const repository = filledRepository(25);
        const seen: number[] = [];

        let before: number | undefined;

        for (let page = 0; page < 20; page += 1) {
            const entries =
                before === undefined
                    ? repository.list('BTCUSDT', 4)
                    : repository.list('BTCUSDT', 4, before);

            if (entries.length === 0) {
                break;
            }

            seen.push(...entries.map((entry) => entry.price));
            before = Math.floor(entries.at(-1)!.timestamp / HOUR_MS);
        }

        expect(seen).toHaveLength(25);
        expect(new Set(seen).size).toBe(25);
        expect(seen[0]).toBe(100_024);
        expect(seen.at(-1)).toBe(100_000);

        repository.close();
    });
});
