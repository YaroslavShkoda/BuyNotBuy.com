import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrations.js';
import { closePool } from './pool.js';

/**
 * The boot race, in a database.
 *
 * Two instances starting together is the ordinary case, not an edge case: the
 * readiness probe and the server bootstrap both call `applyMigrations`. One
 * holds the lock and migrates; the other must wait it out. The version that used
 * `pg_advisory_lock` inherited the pool's 5 second `lock_timeout`, failed the
 * wait, and propagated — and `startServer` answers a failed migration with
 * `process.exit(1)`, so a routine rolling deploy became a crash loop that
 * stopped only when the other instance happened to have finished.
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

    it('waits for a lock another process is holding', async () => {
        const held = await holder.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1, $2) AS locked',
            [NAMESPACE, KEY],
        );

        expect(held.rows[0]?.locked).toBe(true);

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
    });

    it('does not leave the lock held after it finishes', async () => {
        await applyMigrations();

        // If the lock leaked, a second run in the same process would succeed
        // by re-entering a lock it already owns rather than by taking a new
        // one, and a second *process* would wait for the full deadline.
        const free = await holder.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1, $2) AS locked',
            [NAMESPACE, KEY],
        );

        expect(free.rows[0]?.locked).toBe(true);
    });
});
