import type { PoolClient } from 'pg';
import { getPool } from './pool.js';
import type { Migration } from './migrations/types.js';
export type { Migration } from './migrations/types.js';
import { migration001_signal_history } from './migrations/001_signal_history.js';
import { migration002_indicator_vote } from './migrations/002_indicator_vote.js';
import { migration003_strategy_version } from './migrations/003_strategy_version.js';
import { migration004_signal_snapshot } from './migrations/004_signal_snapshot.js';
import { migration005_market_candles } from './migrations/005_market_candles.js';
import { migration006_signal_state } from './migrations/006_signal_state.js';
import { migration007_signal_transition } from './migrations/007_signal_transition.js';
import { migration008_signal_history_context } from './migrations/008_signal_history_context.js';
import { migration009_signal_outcome } from './migrations/009_signal_outcome.js';
import { migration010_retention_policy } from './migrations/010_retention_policy.js';
import { migration011_index_audit } from './migrations/011_index_audit.js';
import { migration012_signal_strategy_version } from './migrations/012_signal_strategy_version.js';
import { migration013_strategy_decision_log } from './migrations/013_strategy_decision_log.js';
import { migration014_holdout_verdict } from './migrations/014_holdout_verdict.js';
import { migration015_asset_registry } from './migrations/015_asset_registry.js';
import { migration016_version_without_an_approval_it_never_earned } from './migrations/016_version_without_an_approval_it_never_earned.js';
import { migration017_stage_must_be_a_stage } from './migrations/017_stage_must_be_a_stage.js';
import { migration018_snapshot_remembers_the_venue } from './migrations/018_snapshot_remembers_the_venue.js';
import { migration019_a_promotion_remembers_which_configuration_it_was_under } from './migrations/019_a_promotion_remembers_which_configuration_it_was_under.js';
import { migration020_rate_limit_window } from './migrations/020_rate_limit_window.js';
import { migration021_strategy_decision_log_natural_key } from './migrations/021_strategy_decision_log_natural_key.js';
import { migration022_instrument_foreign_keys } from './migrations/022_instrument_foreign_keys.js';
import { migration023_instrument_series_identity } from './migrations/023_instrument_series_identity.js';

/** One module per migration; import order is the application order. */
export const MIGRATIONS: readonly Migration[] = [
    migration001_signal_history,
    migration002_indicator_vote,
    migration003_strategy_version,
    migration004_signal_snapshot,
    migration005_market_candles,
    migration006_signal_state,
    migration007_signal_transition,
    migration008_signal_history_context,
    migration009_signal_outcome,
    migration010_retention_policy,
    migration011_index_audit,
    migration012_signal_strategy_version,
    migration013_strategy_decision_log,
    migration014_holdout_verdict,
    migration015_asset_registry,
    migration016_version_without_an_approval_it_never_earned,
    migration017_stage_must_be_a_stage,
    migration018_snapshot_remembers_the_venue,
    migration019_a_promotion_remembers_which_configuration_it_was_under,
    migration020_rate_limit_window,
    migration021_strategy_decision_log_natural_key,
    migration022_instrument_foreign_keys,
    migration023_instrument_series_identity,
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
 * How long a migration job waits for another job to finish migrating.
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
 * `pg_advisory_lock`; a bounded try-lock loop lets concurrent deployment jobs
 * wait for the active migration instead of failing with a lock timeout.
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
 * Serialized across processes by an advisory lock. Concurrent deployment jobs
 * cannot run the same DDL simultaneously or disagree about the version ledger.
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
