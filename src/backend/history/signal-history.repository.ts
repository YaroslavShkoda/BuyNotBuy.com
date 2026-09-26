import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { historyConfig } from '../config/history.config.js';

import type { SignalHistoryEntry } from './signal-history.types.js';

// Signal snapshots are hourly by design, so a one-record-per-hour bucket keeps
// the history meaningful in hours instead of duplicating the same state for
// every page load.
const HOUR_MS = 3_600_000;

const IN_MEMORY_DATABASE_PATH = ':memory:';

/**
 * Bumped whenever the schema changes. Stored in the database itself, so a
 * fresh install and an upgraded one are distinguishable without a separate
 * bookkeeping file that could itself be lost or restored out of step.
 */
const SCHEMA_VERSION = 1;

/**
 * Each migration brings a database at version N to version N + 1.
 *
 * Migrations are append-only and never edited once shipped: a database that
 * has already run version 2 must never see a different version 2 than one that
 * upgrades from 1 today.
 */
const MIGRATIONS: readonly string[] = [
    `
        CREATE TABLE IF NOT EXISTS signal_history (
            symbol TEXT NOT NULL,
            hour_bucket INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
            consensus INTEGER NOT NULL CHECK (consensus >= 0 AND consensus <= 100),
            price REAL NOT NULL,
            PRIMARY KEY (symbol, hour_bucket)
        )
    `,
];

export interface SignalHistoryRepositoryOptions {
    databasePath: string;
    maxEntries: number;
}

export interface SignalHistoryRepository {
    record(entry: SignalHistoryEntry): void;
    list(symbol: string, limit: number, before?: number): SignalHistoryEntry[];
    /** Schema version currently stored in the database file. */
    schemaVersion(): number;
    /**
     * Durability settings in force on this connection.
     *
     * `synchronous` is a per-connection pragma, not a property of the file,
     * so it can only be read back from the connection it was set on — which
     * is exactly why a future health endpoint has to ask the repository
     * rather than open its own connection and guess.
     */
    durabilitySettings(): { journalMode: string; synchronous: string };
    close(): void;
}

interface SignalHistoryRow {
    timestamp: number;
    symbol: string;
    signal: string;
    consensus: number;
    price: number;
}

function readUserVersion(db: DatabaseSync): number {
    const rows = db.prepare('PRAGMA user_version').all() as unknown as Array<{
        user_version: number;
    }>;

    return rows[0]?.user_version ?? 0;
}

function readPragmaText(db: DatabaseSync, pragma: string): string {
    const rows = db.prepare(`PRAGMA ${pragma}`).all() as unknown as Array<
        Record<string, unknown>
    >;

    return String(Object.values(rows[0] ?? {})[0] ?? '');
}

export function createSignalHistoryRepository(
    options: SignalHistoryRepositoryOptions,
): SignalHistoryRepository {
    const isInMemory = options.databasePath === IN_MEMORY_DATABASE_PATH;

    if (!isInMemory) {
        mkdirSync(dirname(options.databasePath), { recursive: true });
    }

    const db = new DatabaseSync(options.databasePath);

    // node:sqlite invalidates prepared statements on close, so a single
    // close() call on the DatabaseSync is the complete lifecycle teardown.
    let isClosed = false;

    const close = (): void => {
        // DatabaseSync.close() is not idempotent (second call throws
        // "database is not open"), so guard against double-close.
        if (isClosed) {
            return;
        }

        isClosed = true;
        db.close();
    };

    // Everything from here down to the prepared statements can throw — a file
    // that is not a database fails on the first exec — and the handle opened
    // above would then stay open for the life of the process. A readiness probe
    // that checks every few seconds would leak one per probe, so teardown is
    // part of the failure path, not a cleanup only the success path runs.
    try {
        if (!isInMemory) {
            // Write-ahead logging lets a reader run while a writer holds the
            // database, and keeps a commit from blocking on a full fsync of the
            // whole file. With a single writer and hourly writes that is the
            // right trade: a crash can lose at most the last few writes, never
            // the file.
            db.exec('PRAGMA journal_mode = WAL');

            // NORMAL still fsyncs at checkpoints, so the database cannot be
            // corrupted by a power cut; it only stops fsyncing on every single
            // commit, which is the part hourly history does not need.
            db.exec('PRAGMA synchronous = NORMAL');
        }

        // A second process (or a leftover handle from a previous run) must wait
        // rather than fail outright.
        db.exec('PRAGMA busy_timeout = 5000');

        const storedVersion = readUserVersion(db);

        if (storedVersion > SCHEMA_VERSION) {
            // Running an older build against a newer file would write a schema
            // it cannot read back. Refusing to start is recoverable; corrupting
            // the history is not.
            throw new Error(
                `Signal history database is at version ${storedVersion}, but this build understands version ${SCHEMA_VERSION}`,
            );
        }

        for (
            let version = storedVersion;
            version < SCHEMA_VERSION;
            version += 1
        ) {
            const migration = MIGRATIONS[version];

            if (migration === undefined) {
                throw new Error(
                    `Missing migration from schema version ${version}`,
                );
            }

            db.exec(migration);
            // PRAGMA does not accept a bound parameter, so the value is an
            // integer this module controls, never anything from the environment.
            db.exec(`PRAGMA user_version = ${version + 1}`);
        }
    } catch (error) {
        close();
        throw error;
    }

    // Newest analysis of the hour wins; a late-arriving older snapshot
    // must not overwrite a fresher one.
    const upsertStatement = db.prepare(`
        INSERT INTO signal_history (symbol, hour_bucket, timestamp, signal, consensus, price)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, hour_bucket) DO UPDATE SET
            timestamp = excluded.timestamp,
            signal = excluded.signal,
            consensus = excluded.consensus,
            price = excluded.price
        WHERE excluded.timestamp > signal_history.timestamp
    `);

    const trimStatement = db.prepare(`
        DELETE FROM signal_history
        WHERE hour_bucket NOT IN (
            SELECT DISTINCT hour_bucket
            FROM signal_history
            ORDER BY hour_bucket DESC
            LIMIT ?
        )
    `);

    const selectStatement = db.prepare(`
        SELECT timestamp, symbol, signal, consensus, price
        FROM signal_history
        WHERE symbol = ?
        ORDER BY hour_bucket DESC
        LIMIT ?
    `);

    // `before` is an hour bucket, so a page boundary is expressed in the same
    // unit the rows are keyed by. Filtering here rather than in memory matters:
    // "give me 20 older entries" has to stay one indexed read, not a full
    // table scan that throws most of it away.
    const selectBeforeStatement = db.prepare(`
        SELECT timestamp, symbol, signal, consensus, price
        FROM signal_history
        WHERE symbol = ?
          AND hour_bucket < ?
        ORDER BY hour_bucket DESC
        LIMIT ?
    `);

    return {
        record(entry: SignalHistoryEntry): void {
            upsertStatement.run(
                entry.symbol,
                Math.floor(entry.timestamp / HOUR_MS),
                entry.timestamp,
                entry.signal,
                Math.round(entry.consensus),
                entry.price,
            );

            trimStatement.run(options.maxEntries);
        },

        list(symbol: string, limit: number, before?: number): SignalHistoryEntry[] {
            // node:sqlite returns generic Record rows; the shape is fixed by
            // our SELECT column list and the CHECK constraint on `signal`,
            // so the two-step cast is intentional and narrow.
            const rows = (
                before === undefined
                    ? selectStatement.all(symbol, limit)
                    : selectBeforeStatement.all(symbol, before, limit)
            ) as unknown as SignalHistoryRow[];

            // The signal column is guarded by a CHECK constraint at the
            // storage layer, so the narrow cast cannot receive foreign values.
            return rows.map((row) => ({
                timestamp: row.timestamp,
                symbol: row.symbol,
                signal: row.signal as SignalHistoryEntry['signal'],
                consensus: row.consensus,
                price: row.price,
            }));
        },

        schemaVersion(): number {
            return readUserVersion(db);
        },

        durabilitySettings() {
            return {
                journalMode: readPragmaText(db, 'journal_mode').toLowerCase(),
                synchronous: readPragmaText(db, 'synchronous'),
            };
        },

        close,
    };
}

let repositoryInstance: SignalHistoryRepository | null = null;

// Lazy singleton: the database file is opened on first use, not on import,
// so importing this module stays free of filesystem side effects.
export function getSignalHistoryRepository(): SignalHistoryRepository {
    repositoryInstance ??= createSignalHistoryRepository({
        databasePath: historyConfig.databasePath,
        maxEntries: historyConfig.maxEntries,
    });

    return repositoryInstance;
}

// Closes the process-wide database handle (e.g. during application shutdown
// or test teardown). On Windows an open SQLite handle keeps the database file
// locked, so an unclosed handle would block later cleanup attempts with EPERM.
// The instance is reset, so a subsequent getSignalHistoryRepository() call
// opens the database again (restart semantics).
export function closeSignalHistoryRepository(): void {
    repositoryInstance?.close();
    repositoryInstance = null;
}

/**
 * Opens the database once, at startup, so a bad file is found then.
 *
 * The repository is a lazy singleton for testability, which means a database
 * written by a newer build would otherwise be discovered on the first market
 * request — the service would start, report itself healthy, and then fail
 * every request. Opening it here turns that into a refusal to boot.
 */
export function assertSignalHistorySchemaReady(): void {
    getSignalHistoryRepository();
}
