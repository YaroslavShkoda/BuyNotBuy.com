import { describe, expect, it } from 'vitest';

import {
    applyMigrations,
    currentSchemaVersion,
    LATEST_SCHEMA_VERSION,
    MIGRATIONS,
} from './migrations';
import { query } from './pool';

describe('migrations', () => {
    it('brings an empty database up to the version this build knows', async () => {
        // The setup file has already applied them, so applying again must be a
        // no-op rather than an error: every service start runs this, and
        // sixteen instances starting at once would run it sixteen times.
        await expect(applyMigrations()).resolves.toBe(LATEST_SCHEMA_VERSION);
        await expect(currentSchemaVersion()).resolves.toBe(LATEST_SCHEMA_VERSION);
    });

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
            await expect(applyMigrations()).rejects.toThrow(
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
    });

    // A note on the flake this file was reported to have.
    //
    // The obvious hardening — wrap the insert above in a transaction and roll it
    // back — was tried and does not work, for an instructive reason: under READ
    // COMMITTED the uncommitted row is invisible to `applyMigrations`, so it
    // resolves happily and the test fails in the other direction. The row has to
    // be committed for the assertion to mean anything, and committed it must be.
    //
    // What remains is that the window is closed by test sequencing rather than
    // by the database: vitest runs the tests in a file one at a time, and the
    // schema is randomised per file, so a run killed mid-test leaves nothing for
    // the next one to trip over. Whether that is sufficient is not known —
    // twenty consecutive runs did not reproduce the failure, and neither did the
    // four checks before this. It is recorded here as unexplained rather than
    // fixed, because a test that has been given a plausible story is worse than
    // one that is still open.
});
