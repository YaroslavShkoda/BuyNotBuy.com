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
    {
        version: 3,
        name: 'strategy_version',
        sql: `
            CREATE TABLE IF NOT EXISTS strategy_version (
                id BIGSERIAL PRIMARY KEY,
                created_at BIGINT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                config JSONB NOT NULL,
                config_hash TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'approved', 'retired'))
            );

            -- A version is identified by what it says, not by when it was
            -- written. Two builds with identical indicator settings must not be
            -- able to create two versions, because a snapshot stored under one
            -- of them would then claim provenance the other claims too, and the
            -- two could not be told apart when the results are read back months
            -- later.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_version_active
            ON strategy_version (config_hash)
            WHERE status <> 'retired';
        `,
    },
    {
        version: 4,
        name: 'signal_snapshot',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_snapshot (
                id BIGSERIAL PRIMARY KEY,
                created_at BIGINT NOT NULL,
                symbol TEXT NOT NULL,
                strategy_version_id BIGINT NOT NULL
                    REFERENCES strategy_version (id) ON DELETE RESTRICT,
                input_hash TEXT NOT NULL,
                snapshot JSONB NOT NULL,
                first_candle_ts BIGINT NOT NULL,
                last_candle_ts BIGINT NOT NULL,
                candle_count INTEGER NOT NULL,
                candles_hash TEXT NOT NULL,

                -- The point of the table. A snapshot that can be edited is one
                -- that can be made to agree with a result measured weeks later,
                -- which is the single thing that would make every walk-forward
                -- and shadow number in the system meaningless. RESTRICT on the
                -- strategy version for the same reason: retiring a version must
                -- not take its evidence with it.
                UNIQUE (symbol, input_hash)
            );

            -- Outcomes are joined to snapshots by id, and an operator asking
            -- "what did it say at the time?" reads the newest ones.
            CREATE INDEX IF NOT EXISTS idx_signal_snapshot_created
            ON signal_snapshot (symbol, created_at DESC);
        `,
    },
    {
        version: 5,
        name: 'market_candles',
        sql: `
            CREATE TABLE IF NOT EXISTS market_candles (
                id BIGSERIAL PRIMARY KEY,
                provider TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                open DOUBLE PRECISION NOT NULL,
                high DOUBLE PRECISION NOT NULL,
                low DOUBLE PRECISION NOT NULL,
                close DOUBLE PRECISION NOT NULL,
                volume DOUBLE PRECISION NOT NULL,
                ingested_at BIGINT NOT NULL,

                -- A candle that is still forming is a different record from the
                -- same candle once it has closed, and storing it as one row
                -- would mean the last bar of every hour is a moving target: the
                -- value read now and the value read an hour later would occupy
                -- the same row, and any backtest run over this table would
                -- silently disagree with itself depending on when it ran.
                --
                -- The primary key is the identity of the bar; this says whether
                -- what is stored is final. A closed bar is the only kind a
                -- backtest is allowed to read.
                is_closed BOOLEAN NOT NULL DEFAULT TRUE,

                CONSTRAINT market_candles_ohlc_sane CHECK (
                    high >= low
                    AND high >= open
                    AND high >= close
                    AND low <= open
                    AND low <= close
                    AND open > 0
                    AND high > 0
                    AND low > 0
                    AND close > 0
                    AND volume >= 0
                ),

                -- The venue is part of the identity, not a column that happens
                -- to be there. Binance and Bitget print different numbers for
                -- the same hour, and a table keyed only by time would keep
                -- whichever row arrived last — so switching venues mid-outage
                -- would rewrite history rather than record it.
                UNIQUE (provider, symbol, interval, timestamp)
            );

            -- Every read of this table is a range over time for one
            -- (provider, symbol, interval), and the unique constraint above
            -- already carries that prefix, so the index that serves them is the
            -- one the constraint builds. Descending, because the only two reads
            -- that run on a hot path — the last known bar and the rows a
            -- backfill still needs — both walk backwards from the newest.
            CREATE INDEX IF NOT EXISTS idx_market_candles_recent
            ON market_candles (provider, symbol, interval, timestamp DESC)
            WHERE is_closed;
        `,
    },
    {
        version: 6,
        name: 'signal_state',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_state (
                id BIGSERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                provider TEXT NOT NULL,
                interval TEXT NOT NULL,

                -- The direction this signal is currently in, not every direction
                -- it has passed through. A signal that flipped LONG to SHORT and
                -- back is a new signal; pretending it is the old one makes the
                -- outcome engine measure a trade nobody held.
                direction TEXT NOT NULL,
                status TEXT NOT NULL,

                -- The snapshot this state was last written from. A foreign key
                -- would be better and cannot be: snapshots are pruned, and a
                -- pruned snapshot must not take the history of every signal
                -- that referenced it with it.
                snapshot_id BIGINT,

                price DOUBLE PRECISION NOT NULL,
                confidence DOUBLE PRECISION NOT NULL,

                -- The bar the signal was published on. The clock for the
                -- cooldown is measured in closed bars, not in wall time, so a
                -- backend that was down for four hours does not come back
                -- believing it is ready to publish.
                published_at BIGINT NOT NULL,
                candle_timestamp BIGINT NOT NULL,

                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,

                CONSTRAINT signal_state_direction_known CHECK (
                    direction IN ('LONG', 'SHORT')
                ),
                CONSTRAINT signal_state_status_known CHECK (
                    status IN (
                        'GENERATED',
                        'ACTIVE',
                        'UPDATED',
                        'INVALIDATED',
                        'EXPIRED',
                        'CLOSED'
                    )
                ),
                CONSTRAINT signal_state_price_positive CHECK (price > 0),
                CONSTRAINT signal_state_confidence_bounded CHECK (
                    confidence >= 0 AND confidence <= 100
                ),

                -- One live signal per series. This is what makes dedup a
                -- database guarantee rather than a check somebody has to
                -- remember to run before writing.
                UNIQUE (symbol, provider, interval)
            );

            -- Every read is "the live signal for this series", and the unique
            -- constraint above already carries that prefix.
            CREATE INDEX IF NOT EXISTS idx_signal_state_status
            ON signal_state (status, updated_at DESC);
        `,
    },
    {
        version: 7,
        name: 'signal_transition',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_transition (
                id BIGSERIAL PRIMARY KEY,
                state_id BIGINT NOT NULL,
                symbol TEXT NOT NULL,
                provider TEXT NOT NULL,
                interval TEXT NOT NULL,

                from_status TEXT,
                to_status TEXT NOT NULL,
                from_direction TEXT,
                to_direction TEXT NOT NULL,

                -- Why it moved, in words a person can act on. "The panel
                -- stopped agreeing" and "the market closed against us" are
                -- different events and the performance of the strategy depends
                -- on telling them apart.
                reason TEXT NOT NULL,

                -- Candle the transition happened on, never wall time. A
                -- transition recorded against a wall clock cannot be lined up
                -- with the bars that caused it.
                candle_timestamp BIGINT NOT NULL,
                price DOUBLE PRECISION NOT NULL,
                created_at BIGINT NOT NULL,

                CONSTRAINT signal_transition_to_known CHECK (
                    to_status IN (
                        'GENERATED',
                        'ACTIVE',
                        'UPDATED',
                        'INVALIDATED',
                        'EXPIRED',
                        'CLOSED'
                    )
                ),
                CONSTRAINT signal_transition_price_positive CHECK (price > 0)
            );

            CREATE INDEX IF NOT EXISTS idx_signal_transition_state
            ON signal_transition (state_id, created_at DESC);

            -- The outcome engine reads every transition of every signal that
            -- has resolved, and there is one series of them per signal. This is
            -- the read the whole of block 18 depends on.
            CREATE INDEX IF NOT EXISTS idx_signal_transition_series
            ON signal_transition (symbol, provider, interval, created_at DESC);
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

/**
 * How long a booting process waits for another one to finish migrating.
 *
 * Long enough for a real migration — adding a constrained column to a large
 * table, building an index — and short enough that a genuinely stuck holder is
 * reported while someone is still watching the rollout.
 */
const MIGRATION_LOCK_WAIT_MS = 30_000;

async function readStoredVersion(client: PoolClient): Promise<number> {
    const result = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
    );

    return result.rows[0]?.version ?? 0;
}

/**
 * Refuses a ledger with a hole in it.
 *
 * `MAX(version)` answers "what is the newest thing that ran", not "what has
 * run". Versions {1, 3} read as 3, and the loop below then skips 2 forever —
 * leaving a database shaped like version 2 that reports itself as version 3,
 * which no restart can recover from because the only evidence of the missing
 * step is the absence the code refuses to look for.
 *
 * Reachable from the code as written: the test suite deletes version rows
 * directly, so a cleanup path that can produce the gap already exists.
 */
async function assertContiguous(client: PoolClient): Promise<void> {
    const result = await client.query<{ count: number; max: number | null }>(
        'SELECT COUNT(*)::int AS count, MAX(version) AS max FROM schema_migrations',
    );

    const row = result.rows[0];
    const count = row?.count ?? 0;
    const max = row?.max ?? 0;

    if (count === 0) {
        return;
    }

    if (count !== max) {
        throw new Error(
            `schema_migrations is not contiguous: ${count} row(s) with a highest ` +
                `version of ${max}. A version is missing, so the schema is ` +
                `neither at 0 nor fully migrated and cannot be repaired by ` +
                `re-running. Restore the missing version from a backup.`,
        );
    }
}

/**
 * Takes the migration lock, waiting for whoever holds it rather than failing.
 *
 * The connection pool sets `lock_timeout` on every connection so a wedged write
 * gives up quickly and lands in the retry buffer. That same setting applies to
 * `pg_advisory_lock`, which is the wrong trade here: during a rolling restart
 * the readiness probe and the server bootstrap arrive together by design, the
 * one holding the lock is applying migrations and about to finish, and the one
 * waiting would fail its wait, propagate, and call `process.exit(1)`. Two
 * instances booting is the normal case, and it was the one case that killed
 * the process.
 *
 * A try-lock with backoff, bounded by an overall deadline, handles both: a
 * holder that finishes is waited out, and a lock that is genuinely stuck is
 * reported as a migration problem rather than as a connection timeout.
 */
async function acquireMigrationLock(
    client: PoolClient,
    deadlineMs: number,
): Promise<void> {
    const startedAt = Date.now();
    let delayMs = 50;

    for (;;) {
        const result = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1, $2) AS locked',
            [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
        );

        if (result.rows[0]?.locked === true) {
            return;
        }

        if (Date.now() - startedAt >= deadlineMs) {
            throw new Error(
                `Could not take the migration lock within ${deadlineMs}ms. ` +
                    'Another process is applying migrations and has not finished; ' +
                    'if none is, it died holding the lock and its connection is ' +
                    'still open.',
            );
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 1_000);
    }
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
        // No `SET lock_timeout` here, and that is deliberate. The pool sets one
        // on every connection so a wedged write gives up quickly, and an
        // earlier version of this function raised the timeout for the
        // migration session and put the old value back only on the happy path —
        // so a migration that threw left `30s` on a connection that went back
        // to the pool, and the next borrower inherited it. The wait this
        // function needs is the lock wait, and the lock wait is not a
        // server-side one: `pg_try_advisory_lock` never blocks, so the deadline
        // is kept in this loop and no session setting is involved at all.
        await acquireMigrationLock(client, MIGRATION_LOCK_WAIT_MS);

        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at BIGINT NOT NULL
            )
        `);

        await assertContiguous(client);

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
