import { getPool } from './pool.js';

import type { PoolClient } from 'pg';

export interface Migration {
    readonly version: number;
    readonly name: string;
    readonly sql: string;
}

/**
 * Every schema change, in order, applied exactly once.
 *
 * Append-only, and a shipped migration is never edited: a database that has
 * already run version 2 must never see a different version 2 than one that
 * upgrades to it tomorrow. A correction goes in as version 3.
 *
 * PostgreSQL has no equivalent of SQLite's `PRAGMA user_version`, so the
 * applied versions live in a table in the database itself. That keeps the
 * bookkeeping in the same transactional boundary as the change it records —
 * a crash between `CREATE TABLE` and the version row would otherwise leave a
 * schema nobody knows the version of.
 */
export const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        name: 'signal_history',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_history (
                symbol TEXT NOT NULL,
                hour_bucket BIGINT NOT NULL,
                timestamp BIGINT NOT NULL,
                signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
                consensus INTEGER NOT NULL CHECK (consensus >= 0 AND consensus <= 100),
                price DOUBLE PRECISION NOT NULL,
                PRIMARY KEY (symbol, hour_bucket)
            )
        `,
    },
    {
        version: 2,
        name: 'indicator_vote',
        sql: `
            CREATE TABLE IF NOT EXISTS indicator_vote (
                symbol TEXT NOT NULL,
                vote_bucket BIGINT NOT NULL,
                timestamp BIGINT NOT NULL,
                indicator TEXT NOT NULL,
                signal TEXT NOT NULL CHECK (signal IN ('LONG', 'SHORT', 'NEUTRAL')),
                weight INTEGER NOT NULL CHECK (weight >= 0 AND weight <= 100),
                price DOUBLE PRECISION NOT NULL,
                fwd_return_1h DOUBLE PRECISION,
                fwd_return_4h DOUBLE PRECISION,
                fwd_return_24h DOUBLE PRECISION,
                PRIMARY KEY (symbol, vote_bucket, indicator)
            );

            -- The settlement scan filters on the unresolved horizons, so those
            -- three columns get an index of their own rather than a table scan
            -- every poller cycle.
            CREATE INDEX IF NOT EXISTS idx_indicator_vote_unsettled
            ON indicator_vote (symbol, timestamp)
            WHERE fwd_return_1h IS NULL
               OR fwd_return_4h IS NULL
               OR fwd_return_24h IS NULL;
        `,
    },
];

/** Newest schema version this build knows how to produce. */
export const LATEST_SCHEMA_VERSION: number =
    MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/*
 * Advisory lock key, split into two 32-bit halves so it stays a plain number.
 * Any constant will do — its only job is to be the same across processes.
 */
const MIGRATION_LOCK_NAMESPACE = 0x627564;
const MIGRATION_LOCK_KEY = 0x6e627579;

async function readStoredVersion(client: PoolClient): Promise<number> {
    const result = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
    );

    return result.rows[0]?.version ?? 0;
}

/**
 * Brings the database up to `LATEST_SCHEMA_VERSION` and returns that version.
 *
 * Serialized across processes by an advisory lock: the readiness probe and the
 * server bootstrap can both arrive here at once during a rolling restart, and
 * two of them running migration 2 together means one of them fails on a
 * duplicate object, or worse, succeeds while the other believes it did.
 */
export async function applyMigrations(): Promise<number> {
    const client = await getPool().connect();

    try {
        await client.query('SELECT pg_advisory_lock($1, $2)', [
            MIGRATION_LOCK_NAMESPACE,
            MIGRATION_LOCK_KEY,
        ]);

        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at BIGINT NOT NULL
            )
        `);

        const storedVersion = await readStoredVersion(client);

        if (storedVersion > LATEST_SCHEMA_VERSION) {
            // Running an older build against a newer database would write a
            // schema it cannot read back. Refusing to start is recoverable;
            // corrupting the history is not.
            throw new Error(
                `Database is at schema version ${storedVersion}, but this build ` +
                    `understands version ${LATEST_SCHEMA_VERSION}`,
            );
        }

        for (const migration of MIGRATIONS) {
            if (migration.version <= storedVersion) {
                continue;
            }

            await client.query('BEGIN');

            try {
                await client.query(migration.sql);
                await client.query(
                    `INSERT INTO schema_migrations (version, name, applied_at)
                     VALUES ($1, $2, $3)`,
                    [migration.version, migration.name, Date.now()],
                );
                await client.query('COMMIT');
            } catch (error) {
                // A failed ROLLBACK means the connection itself is gone, and
                // the original error is the one worth reporting.
                await client.query('ROLLBACK').catch(() => undefined);

                throw error;
            }
        }

        return LATEST_SCHEMA_VERSION;
    } finally {
        await client
            .query('SELECT pg_advisory_unlock($1, $2)', [
                MIGRATION_LOCK_NAMESPACE,
                MIGRATION_LOCK_KEY,
            ])
            .catch(() => undefined);

        client.release();
    }
}

/** Highest applied version, or 0 when the database has never been migrated. */
export async function currentSchemaVersion(): Promise<number> {
    const client = await getPool().connect();

    try {
        const exists = await client.query<{ present: boolean }>(
            `SELECT to_regclass('schema_migrations') IS NOT NULL AS present`,
        );

        if (exists.rows[0]?.present !== true) {
            return 0;
        }

        return await readStoredVersion(client);
    } finally {
        client.release();
    }
}
