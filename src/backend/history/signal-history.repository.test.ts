import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
    LATEST_SCHEMA_VERSION,
    applyMigrations,
    currentSchemaVersion,
} from '../db/migrations.js';
import { query } from '../db/pool.js';
import {
    assertSignalHistorySchemaReady,
    createSignalHistoryRepository,
} from './signal-history.repository.js';

import type { SignalHistoryRepository } from './signal-history.repository.js';
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

/**
 * Stages a `schema_migrations` row this build cannot understand, then removes
 * it again.
 *
 * A database written by a newer build is the one thing a test cannot ask the
 * server to produce on demand, and that version row is the entire evidence
 * the migration code goes on — so the test writes it by hand. The removal is
 * not optional: the version bookkeeping lives in its own table, which the
 * per-test `TRUNCATE` of the two service tables never touches.
 */
async function withStoredSchemaVersion(
    version: number,
    work: () => Promise<void>,
): Promise<void> {
    await query(
        `INSERT INTO schema_migrations (version, name, applied_at)
         VALUES ($1, $2, $3)`,
        [version, 'written_by_a_newer_build', 1_737_950_400_000],
    );

    try {
        await work();
    } finally {
        await query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    }
}

describe('signal history repository', () => {
    it('stores and returns an entry with all fields preserved', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        await repository.record(makeEntry());

        expect(await repository.list('BTCUSDT', 10)).toEqual([makeEntry()]);
    });

    it('keeps a single record per hour and the newest analysis wins', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        const hourStart = 1_737_950_400_000;

        await repository.record(makeEntry({
            timestamp: hourStart + 10 * 60_000,
            signal: 'LONG',
            price: 99_000,
        }));

        await repository.record(makeEntry({
            timestamp: hourStart + 40 * 60_000,
        }));

        const entries = await repository.list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(hourStart + 40 * 60_000);
        expect(entries[0]?.signal).toBe('SHORT');
        expect(entries[0]?.price).toBe(100_000);
    });

    it('does not overwrite a newer record with a late-arriving older snapshot', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        const hourStart = 1_737_950_400_000;

        await repository.record(makeEntry({
            timestamp: hourStart + 40 * 60_000,
        }));

        await repository.record(makeEntry({
            timestamp: hourStart + 10 * 60_000,
            signal: 'LONG',
        }));

        const entries = await repository.list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(hourStart + 40 * 60_000);
        expect(entries[0]?.signal).toBe('SHORT');
    });

    it('returns entries newest-first across hours', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        const dayStart = 1_737_936_000_000;

        await repository.record(makeEntry({ timestamp: dayStart + 2 * HOUR_MS }));
        await repository.record(makeEntry({ timestamp: dayStart + HOUR_MS }));
        await repository.record(makeEntry({ timestamp: dayStart }));

        const entries = await repository.list('BTCUSDT', 10);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 2 * HOUR_MS,
            dayStart + HOUR_MS,
            dayStart,
        ]);
    });

    it('limits the number of returned entries to the newest ones', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        const dayStart = 1_737_936_000_000;

        for (let hour = 0; hour < 5; hour += 1) {
            await repository.record(makeEntry({ timestamp: dayStart + hour * HOUR_MS }));
        }

        const entries = await repository.list('BTCUSDT', 2);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 4 * HOUR_MS,
            dayStart + 3 * HOUR_MS,
        ]);
    });

    it('trims retained entries down to maxEntries keeping the newest', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 3 });

        const dayStart = 1_737_936_000_000;

        for (let hour = 0; hour < 5; hour += 1) {
            await repository.record(makeEntry({ timestamp: dayStart + hour * HOUR_MS }));
        }

        const entries = await repository.list('BTCUSDT', 10);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 4 * HOUR_MS,
            dayStart + 3 * HOUR_MS,
            dayStart + 2 * HOUR_MS,
        ]);
    });

    it('keeps symbols independent', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        await repository.record(makeEntry());
        await repository.record(makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }));

        expect(await repository.list('BTCUSDT', 10)).toEqual([makeEntry()]);
        expect(await repository.list('ETHUSDT', 10)).toEqual([
            makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }),
        ]);
    });

    it('rounds consensus to an integer', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        await repository.record(makeEntry({ consensus: 66.6 }));

        const entries = await repository.list('BTCUSDT', 10);

        expect(entries[0]?.consensus).toBe(67);
    });

    it('returns an empty list for unknown symbol', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        expect(await repository.list('BTCUSDT', 10)).toEqual([]);
    });
});

/**
 * Same connection string, different `search_path`.
 *
 * Everything already in `options` is kept and only the `search_path` entry is
 * swapped, so the timeouts the pool puts there travel with the new URL. Used
 * by the fresh-database test below, which needs module registrations built
 * from a connection string that points somewhere else.
 */
function withSearchPath(url: string, schema: string): string {
    const parsed = new URL(url);
    const carried = parsed.searchParams.get('options') ?? '';
    const kept = carried
        .split(' ')
        .filter((option) => !option.startsWith('-c search_path='))
        .join(' ');

    parsed.searchParams.set('options', `${kept} -c search_path=${schema}`.trim());

    return parsed.toString();
}

describe('signal history schema', () => {
    it('records its version in the database', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        // A version number stored in the database is what makes an upgrade
        // distinguishable from a fresh install.
        expect(await repository.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);

        // Read straight out of the bookkeeping table rather than through the
        // repository: the point is that the number is *stored*, so going back
        // through the code under test would prove nothing.
        const stored = await query<{ version: number }>(
            'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
        );

        expect(stored.rows[0]?.version).toBe(LATEST_SCHEMA_VERSION);
    });

    it('keeps the version across a new repository instance', async () => {
        // A repository no longer owns a connection or a file, so there is
        // nothing to reopen — the version lives in the database, which is
        // exactly why a second instance over the same database reads back the
        // same number. That is the property a restart depends on.
        const first = createSignalHistoryRepository({ maxEntries: 720 });
        const second = createSignalHistoryRepository({ maxEntries: 720 });

        expect(await first.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
        expect(await second.schemaVersion()).toBe(await first.schemaVersion());
    });

    it('refuses a database written by a newer build, and leaves it alone', async () => {
        await withStoredSchemaVersion(99, async () => {
            // An older build writing into a newer schema would produce a
            // database it cannot read back. Refusing to start is recoverable;
            // corrupting the history is not.
            await expect(applyMigrations()).rejects.toThrow(/version 99/);

            // The refusal is a refusal, not a repair: the version the newer
            // build left behind is still exactly where it was.
            expect(await currentSchemaVersion()).toBe(99);
        });
    });

    it('finds an unusable database at startup, not at the first request', async () => {
        await withStoredSchemaVersion(99, async () => {
            // The repository is a lazy factory for testability, so without an
            // explicit startup check a service would boot, report itself
            // healthy, and then fail every market request.
            await expect(assertSignalHistorySchemaReady()).rejects.toThrow(
                /version 99/,
            );

            // Failing that check must not take the shared pool down with it.
            // The pool is process-wide, so a connection left holding the
            // migration lock, or stuck in a failed transaction, would break
            // every later caller rather than just the one that failed.
            const repository = createSignalHistoryRepository({ maxEntries: 720 });
            await expect(repository.record(makeEntry())).resolves.toBeUndefined();

            expect(await repository.list('BTCUSDT', 10)).toEqual([makeEntry()]);
        });
    });

    it('creates the tables on a database that has never been written to', async () => {
        // A fresh deployment boots into a database with no tables and no
        // migration bookkeeping, and the readiness probe has to be able to fix
        // that on its own. Reaching that state from inside a test that already
        // has a migrated database would mean dropping the tables every other
        // test in this file is using, so this one gets a schema of its own and
        // a second set of module registrations pointed at it — which is the
        // only way to get a genuinely untouched database to migrate.
        const schema = `buynotbuy_fresh_${randomUUID().replace(/-/g, '')}`;
        const previousUrl = process.env.DATABASE_URL ?? '';

        await query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

        process.env.DATABASE_URL = withSearchPath(previousUrl, schema);
        vi.resetModules();

        try {
            const migrations = await import('../db/migrations.js');
            const pool = await import('../db/pool.js');
            const repository = await import('./signal-history.repository.js');

            try {
                expect(await migrations.currentSchemaVersion()).toBe(0);
                expect(await migrations.applyMigrations()).toBe(
                    migrations.LATEST_SCHEMA_VERSION,
                );
                expect(await migrations.currentSchemaVersion()).toBe(
                    migrations.LATEST_SCHEMA_VERSION,
                );

                // The tables the repository needs are the ones the migrations
                // created — nothing else creates them.
                const tables = await pool.query<{ name: string | null }>(
                    "SELECT to_regclass('signal_history')::text AS name",
                );

                expect(tables.rows[0]?.name).toBe('signal_history');

                const fresh = repository.createSignalHistoryRepository({
                    maxEntries: 720,
                });

                await fresh.record(makeEntry());

                expect(await fresh.list('BTCUSDT', 10)).toEqual([makeEntry()]);

                // Applying again is a no-op rather than a second set of
                // tables, so a probe that runs every few seconds is free.
                expect(await migrations.applyMigrations()).toBe(
                    migrations.LATEST_SCHEMA_VERSION,
                );
            } finally {
                // The second set of registrations owns a second pool. Nothing
                // else closes it, and a pool left open keeps the process alive.
                await pool.closePool();
            }
        } finally {
            process.env.DATABASE_URL = previousUrl;
            vi.resetModules();
            await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
    });

    it('rejects a signal the storage layer does not allow', async () => {
        // `list()` casts the signal column without validating it, on the
        // grounds that the CHECK constraint makes a foreign value impossible.
        // That is only true while the constraint is there, and a missing
        // constraint would make the cast quietly wrong instead of loudly
        // wrong — so the guarantee is asserted here, at the server.
        //
        // Matched on the constraint's *name*, not on the words of the error.
        // PostgreSQL localises its messages, so an installation with a
        // non-English `lc_messages` reports this in that language and a
        // message match would fail on a server that is working correctly.
        // The name is the migration's, and is the same everywhere.
        await expect(
            query(
                `INSERT INTO signal_history
                     (symbol, hour_bucket, timestamp, signal, consensus, price)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['BTCUSDT', 482_000, 1_737_950_400_000, 'VERY_LONG', 50, 100_000],
            ),
        ).rejects.toThrow(/signal_history_signal_check/);

        // ... and the row really was refused rather than stored and read back.
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        expect(await repository.list('BTCUSDT', 10)).toEqual([]);
    });
});

describe('signal history durability', () => {
    it('reports the server-side timeouts in force on the pool', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        // SQLite's durability knobs — the write-ahead log, and
        // `synchronous = NORMAL` so a commit does not fsync — have no
        // PostgreSQL equivalent worth asserting here. WAL is a property of the
        // server's own storage, chosen cluster-wide rather than per client, and
        // how often the server fsyncs is neither readable back nor something a
        // client can influence. What took their place is the pair of
        // per-connection limits below, and those *are* per-connection state:
        // they are sent to the server with the connection string, so reading
        // them back off the pool is the check that a health endpoint asking
        // for them gets the values the running connections actually carry.
        const settings = await repository.durabilitySettings();

        expect(settings.statementTimeout).toBe('10s');
        expect(settings.lockTimeout).toBe('5s');
    });

    it('keeps the data readable by a separate connection while a writer holds it', async () => {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });
        await repository.record(makeEntry());

        // A read through a different pooled connection has to see the committed
        // row. The SQLite version of this test proved it with a second file
        // handle, which a rollback journal would have refused outright; the
        // guarantee is the same one arriving by a different mechanism now.
        const rows = await query<{ total: number }>(
            'SELECT COUNT(*)::int AS total FROM signal_history',
        );

        expect(rows.rows[0]?.total).toBe(1);
    });

    it('leaves nothing half-written when the retention trim fails', async () => {
        // `record()` stores the snapshot and trims the retention window in one
        // transaction, so a trim that fails has to take the snapshot with it.
        // A stored entry with no corresponding trim is exactly what a
        // half-applied retention policy looks like from the outside. A
        // negative LIMIT is the one trim failure a test can provoke without
        // corrupting anything first: the server rejects it outright.
        const repository = createSignalHistoryRepository({ maxEntries: -1 });

        await expect(repository.record(makeEntry())).rejects.toThrow();

        const afterFailure = await query<{ total: number }>(
            'SELECT COUNT(*)::int AS total FROM signal_history',
        );

        expect(afterFailure.rows[0]?.total).toBe(0);

        // The client that ran the failed transaction goes back to the pool, so
        // the next write has to work. A connection left mid-transaction would
        // fail here, and in production long after the cause.
        const healthy = createSignalHistoryRepository({ maxEntries: 720 });
        await expect(healthy.record(makeEntry())).resolves.toBeUndefined();

        expect(await healthy.list('BTCUSDT', 10)).toEqual([makeEntry()]);
    });
});

describe('signal history pagination', () => {
    const START = 1_737_936_000_000;

    async function filledRepository(hours: number): Promise<SignalHistoryRepository> {
        const repository = createSignalHistoryRepository({ maxEntries: 720 });

        for (let hour = 0; hour < hours; hour += 1) {
            await repository.record(
                makeEntry({
                    timestamp: START + hour * HOUR_MS,
                    price: 100_000 + hour,
                }),
            );
        }

        return repository;
    }

    it('returns the newest records first', async () => {
        const repository = await filledRepository(10);

        const page = await repository.list('BTCUSDT', 3);

        expect(page.map((entry) => entry.price)).toEqual([100_009, 100_008, 100_007]);
    });

    it('continues strictly below the last record of the previous page', async () => {
        const repository = await filledRepository(10);

        const first = await repository.list('BTCUSDT', 4);
        const boundary = Math.floor(first.at(-1)!.timestamp / HOUR_MS);
        const second = await repository.list('BTCUSDT', 4, boundary);

        expect(second.map((entry) => entry.price)).toEqual([
            100_005, 100_004, 100_003, 100_002,
        ]);

        // The last record of one page is the boundary, so consecutive pages
        // must not overlap. A duplicate here would be counted as a second
        // hour in the stability summary.
        for (const entry of second) {
            expect(Math.floor(entry.timestamp / HOUR_MS)).toBeLessThan(boundary);
        }
    });

    it('returns nothing past the oldest record', async () => {
        const repository = await filledRepository(3);

        const page = await repository.list('BTCUSDT', 4);
        const boundary = Math.floor(page.at(-1)!.timestamp / HOUR_MS);

        // An empty page is how the end of the record announces itself.
        expect(await repository.list('BTCUSDT', 4, boundary)).toEqual([]);
    });

    it('returns nothing for a boundary before the whole record', async () => {
        const repository = await filledRepository(3);

        expect(await repository.list('BTCUSDT', 4, 0)).toEqual([]);
    });

    it('reaches every record exactly once when walked page by page', async () => {
        const repository = await filledRepository(25);
        const seen: number[] = [];

        let before: number | undefined;

        for (let page = 0; page < 20; page += 1) {
            const entries =
                before === undefined
                    ? await repository.list('BTCUSDT', 4)
                    : await repository.list('BTCUSDT', 4, before);

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
    });
});
