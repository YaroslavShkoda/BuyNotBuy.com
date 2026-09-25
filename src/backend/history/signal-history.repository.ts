import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { historyConfig } from '../config/history.config';

import type { SignalHistoryEntry } from './signal-history.types';

// Signal snapshots are hourly by design: analysis runs per request (no
// poller), so a one-record-per-hour bucket keeps the history meaningful
// in hours instead of duplicating the same state for every page load.
const HOUR_MS = 3_600_000;

const IN_MEMORY_DATABASE_PATH = ':memory:';

export interface SignalHistoryRepositoryOptions {
    databasePath: string;
    maxEntries: number;
}

export interface SignalHistoryRepository {
    record(entry: SignalHistoryEntry): void;
    list(symbol: string, limit: number): SignalHistoryEntry[];
    close(): void;
}

interface SignalHistoryRow {
    timestamp: number;
    symbol: string;
    signal: string;
    consensus: number;
    price: number;
}

export function createSignalHistoryRepository(
    options: SignalHistoryRepositoryOptions,
): SignalHistoryRepository {
    if (options.databasePath !== IN_MEMORY_DATABASE_PATH) {
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS signal_history (
            symbol TEXT NOT NULL,
            hour_bucket INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
            consensus INTEGER NOT NULL CHECK (consensus >= 0 AND consensus <= 100),
            price REAL NOT NULL,
            PRIMARY KEY (symbol, hour_bucket)
        )
    `);

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

        list(symbol: string, limit: number): SignalHistoryEntry[] {
            // node:sqlite returns generic Record rows; the shape is fixed by
            // our SELECT column list and the CHECK constraint on `signal`,
            // so the two-step cast is intentional and narrow.
            const rows = selectStatement.all(symbol, limit) as unknown as SignalHistoryRow[];

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
