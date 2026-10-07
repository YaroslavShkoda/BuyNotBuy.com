import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrations.js';
import { closePool } from './pool.js';

/**
 * Concurrent migration jobs, in a database.
 *
 * Two deployment jobs can overlap during a rollout. One holds the lock and
 * migrates; the other must wait it out. The version that used
 * `pg_advisory_lock` inherited the pool's 5 second `lock_timeout`, failed the
 * wait and propagated, so a concurrent migration job failed despite the first
 * job making progress.
 *
 * The tests hold the lock from a separate connection, because that is the only
 * way to be genuinely sure it is already taken when `applyMigrations` runs.
 */
describe('migration lock', () => {
    // The same two constants the migration code uses, so a test cannot keep
    // passing after the production key changes.
    const NAMESPACE = 0x627564;
    const KEY = 0x6e627579;

    // A client per test, not one shared: `end()` closes it for good and
    // `connect()` refuses to revive it.
    let holder: Client;

    beforeEach(async () => {
        holder = new Client({ connectionString: process.env.DATABASE_URL });
        await holder.connect();
    });

    afterEach(async () => {
        await holder.end();
        await closePool();
    });

    /**
     * Takes the lock, waiting for whoever has it.
     *
     * The key belongs to the database, not to a schema, and this file's suite
     * runs beside eighty-six others that each migrate in `beforeAll` — so the
     * lock is usually already taken by a neighbour. Retrying is the difference
     * between a test that proves the wait and a test that fails on a full
     * machine for no reason.
     *
     * **The ceiling here used to be exactly vitest's five second default** —
     * a hundred attempts at fifty milliseconds — so `takeLock` could spend the
     * entire test budget and then be killed at the same moment, which reads as
     * a timeout and not as the thing that caused it. The retry ceiling stays an
     * honest bound on "a neighbour kept the lock"; the test's budget is now
     * comfortably above it, so running out of budget means running out of
     * patience, not running out of time.
     */
    const LOCK_ATTEMPTS = 100;
    const LOCK_RETRY_MS = 50;

    /** The budget for these tests, well past the retry ceiling above. */
    const LOCK_WAIT_BUDGET_MS = 30_000;

    async function takeLock(): Promise<void> {
        for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
            const result = await holder.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1, $2) AS locked',
                [NAMESPACE, KEY],
            );

            if (result.rows[0]?.locked === true) {
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        }

        throw new Error('another test file kept the migration lock');
    }

    it('waits for a lock another process is holding', async () => {
        await takeLock();

        // Released well past the pool's `statement_timeout`, so this can only
        // pass if the wait is not a blocking server-side one.
        const release = new Promise<void>((resolve) => {
            setTimeout(() => {
                void holder
                    .query('SELECT pg_advisory_unlock($1, $2)', [NAMESPACE, KEY])
                    .then(() => {
                        resolve();
                    });
            }, 1_500);
        });

        const started = Date.now();
        const migrations = applyMigrations();

        await release;

        expect(await migrations).toBeGreaterThan(0);
        expect(Date.now() - started).toBeGreaterThan(1_000);
    }, LOCK_WAIT_BUDGET_MS);

    it('does not leave the lock held after it finishes', async () => {
        await applyMigrations();

        // If the lock leaked, a second run in the same process would succeed
        // by re-entering a lock it already owns rather than by taking a new
        // one, and a second *process* would wait for the full deadline.
        await takeLock();
    }, LOCK_WAIT_BUDGET_MS);
});
