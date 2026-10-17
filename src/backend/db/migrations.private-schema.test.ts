import { describe, expect, it } from 'vitest';

import {
    applyMigrations,
    LATEST_SCHEMA_VERSION,
    MIGRATION_LOCK_KEY,
    MIGRATION_LOCK_NAMESPACE,
} from './migrations';
import { getPool } from './pool';

/**
 * The advisory lock serializes writers to one shared database; the test suite
 * migrates ~250 private per-file schemas, and queueing those chains behind the
 * global lock was the "Could not take the migration lock" flake. The
 * `skipAdvisoryLock` option exists for those private schemas, and these tests
 * hold its contract: skipping the lock skips ONLY the lock.
 */

const BUDGET_MS = 30_000;

describe('applyMigrations with skipAdvisoryLock', () => {
    it('runs while another session holds the migration lock', async () => {
        const client = await getPool().connect();

        try {
            // A session-level lock on the exact key the locked path takes. If
            // the option leaked and consulted the lock at all, this call would
            // rather throw its deadline error than resolve.
            await client.query('SELECT pg_advisory_lock($1, $2)', [
                MIGRATION_LOCK_NAMESPACE,
                MIGRATION_LOCK_KEY,
            ]);

            await expect(
                applyMigrations({ skipAdvisoryLock: true }),
            ).resolves.toBe(LATEST_SCHEMA_VERSION);
        } finally {
            await client
                .query('SELECT pg_advisory_unlock($1, $2)', [
                    MIGRATION_LOCK_NAMESPACE,
                    MIGRATION_LOCK_KEY,
                ])
                .catch(() => undefined);
            client.release();
        }
    }, BUDGET_MS);

    it('still refuses a ledger from a newer build — only the lock is skipped', async () => {
        const future = LATEST_SCHEMA_VERSION + 1;

        await getPool().query(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
            [future, 'from_the_future', Date.now()],
        );

        try {
            await expect(
                applyMigrations({ skipAdvisoryLock: true }),
            ).rejects.toThrow(/understands version/);
        } finally {
            await getPool().query(
                'DELETE FROM schema_migrations WHERE version = $1',
                [future],
            );
        }

        // The lying row is gone and the schema is where it claims to be.
        await getPool().query('SELECT MAX(version) FROM schema_migrations');
        const result = await getPool().query<{ version: number }>(
            'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
        );

        expect(result.rows[0]?.version).toBe(LATEST_SCHEMA_VERSION);
    }, BUDGET_MS);

    it('keeps the locked path serialized: concurrent calls all resolve', async () => {
        // The production path takes the same lock; two callers racing on one
        // schema must both come back at the latest version rather than one of
        // them failing on the ledger or the lock.
        await expect(
            Promise.all([applyMigrations(), applyMigrations()]),
        ).resolves.toEqual([LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION]);
    }, BUDGET_MS);
});
