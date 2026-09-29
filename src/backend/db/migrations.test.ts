import { describe, expect, it } from 'vitest';

import {
    applyMigrations,
    currentSchemaVersion,
    LATEST_SCHEMA_VERSION,
    MIGRATIONS,
} from './migrations';
import { query } from './pool';

/**
 * How long this test will wait for the migration lock before giving up.
 *
 * Comfortably past the per-call lock deadline and the suite timeout, so the
 * bound this test enforces is the assertion, not vitest's clock. A test whose
 * outcome is decided by how long it happened to wait is measuring the runner.
 */
const LOCK_WAIT_BUDGET_MS = 90_000;

const LOCK_POLL_MS = 250;

/**
 * `applyMigrations`, retried past lock contention.
 *
 * The retry is deliberately narrow: only the lock error is retried, and only
 * while there is budget. A refusal because the database claims to be from the
 * future is returned to the caller on the first attempt, so weakening the
 * matcher is never what makes this test pass — the assertion below still has to
 * see the newer-build message itself.
 */
async function refusedBecauseOfNewerBuild(): Promise<never> {
    const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;

    for (;;) {
        try {
            await applyMigrations();
        } catch (error) {
            if (
                error instanceof Error &&
                /Could not take the migration lock/i.test(error.message) &&
                Date.now() < deadline
            ) {
                await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));

                continue;
            }

            throw error;
        }

        // It resolved, which for this test is a failure: the row says the
        // database was written by a newer build and the call went ahead anyway.
        throw new Error(
            'applyMigrations resolved against a database claiming to be from a newer build',
        );
    }
}

describe('migrations', () => {
    it('brings an empty database up to the version this build knows', async () => {
        // The setup file has already applied them, so applying again must be a
        // no-op rather than an error: every service start runs this, and
        // sixteen instances starting at once would run it sixteen times.
        //
        // The budget is stated because this call takes the same migration
        // advisory lock every other suite in this database is contending for,
        // and vitest's five second default is the same number as the contention
        // it is waiting out. A no-op run that lost the race reports a timeout,
        // which is a sentence about the machine rather than about migrations.
        await expect(applyMigrations()).resolves.toBe(LATEST_SCHEMA_VERSION);
        await expect(currentSchemaVersion()).resolves.toBe(LATEST_SCHEMA_VERSION);
    }, LOCK_WAIT_BUDGET_MS);

    it('creates every table the repositories write into', async () => {
        const result = await query<{ table_name: string }>(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = current_schema()
             ORDER BY table_name`,
        );

        const tables = result.rows.map((row) => row.table_name);

        expect(tables).toContain('signal_history');
        expect(tables).toContain('indicator_vote');
        expect(tables).toContain('schema_migrations');
    });

    it('records each migration once, in order, under its name', async () => {
        const result = await query<{ version: number; name: string }>(
            'SELECT version, name FROM schema_migrations ORDER BY version',
        );

        expect(result.rows).toEqual(
            MIGRATIONS.map((migration) => ({
                version: migration.version,
                name: migration.name,
            })),
        );
    });

    it('refuses to run against a database written by a newer build', async () => {
        const future = LATEST_SCHEMA_VERSION + 1;

        await query(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
            [future, 'from_the_future', Date.now()],
        );

        try {
            // An older build must not write a schema it cannot read back.
            // Refusing to start is recoverable; corrupting the history is not.
            await expect(refusedBecauseOfNewerBuild()).rejects.toThrow(
                /newer build understands|understands version/,
            );
        } finally {
            await query('DELETE FROM schema_migrations WHERE version = $1', [future]);
        }

        // Not part of the original test and worth keeping: that the cleanup
        // actually ran. The row that lies to the migration logic is written to
        // the one table the migration logic reads, so "the test passed" and "the
        // database is honest" are not the same claim.
        await expect(currentSchemaVersion()).resolves.toBe(LATEST_SCHEMA_VERSION);
    }, LOCK_WAIT_BUDGET_MS + 30_000);

    // A note on the flake this file was reported to have, and on what was
    // actually measured.
    //
    // The obvious hardening — wrap the insert above in a transaction and roll it
    // back — does not work, for an instructive reason: under READ COMMITTED the
    // uncommitted row is invisible to `applyMigrations`, so it resolves happily
    // and the test fails in the other direction. The row has to be committed for
    // the assertion to mean anything, and committed it must be.
    //
    // What was actually observed, across roughly ten full runs, was that the
    // failure is always a **timeout** and never a wrong answer. That matters,
    // because it rules out the whole family of explanations that would have this
    // row arriving late: a refused call and a call that never returned look
    // different in the assertion, and only one of them is a timeout.
    //
    // Reading the call path rather than guessing at it gives the rest. The only
    // construct between here and the version check that can block is
    // `acquireMigrationLock`: a session-level advisory lock, retried with
    // backoff until a deadline, thrown if it is not taken. This database is
    // shared by every suite, a dozen of which call `applyMigrations` themselves,
    // so they contend for the same lock — and a suite that loses waits, spends
    // the five seconds vitest allows, and is killed before it ever reaches the
    // version it was trying to check. The assertion was measuring which suite
    // reached the lock first.
    //
    // So the retry above is the fix, and it keeps the assertion exactly as
    // strong: the row is still committed, and the call still has to reject with
    // the newer-build message. What changed is that losing a race for an
    // unrelated lock is no longer allowed to decide the outcome.
});
