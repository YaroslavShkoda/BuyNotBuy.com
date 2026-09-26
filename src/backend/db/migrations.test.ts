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
    });
});
