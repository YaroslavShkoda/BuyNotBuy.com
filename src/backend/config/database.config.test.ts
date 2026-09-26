import { afterEach, describe, expect, it, vi } from 'vitest';

const DATABASE_ENV_KEYS = [
    'DATABASE_URL',
    'DB_POOL_MAX',
    'DB_IDLE_TIMEOUT_MS',
    'DB_CONNECT_TIMEOUT_MS',
    'DB_STATEMENT_TIMEOUT_MS',
    'DB_LOCK_TIMEOUT_MS',
    'DB_APPLICATION_NAME',
] as const;

/** The test setup rewrites this to point at this file's own schema. */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function clearDatabaseEnv(): void {
    for (const key of DATABASE_ENV_KEYS) {
        delete process.env[key];
    }
}

function withDatabaseUrl(url: string): void {
    clearDatabaseEnv();
    process.env.DATABASE_URL = url;
}

afterEach(() => {
    clearDatabaseEnv();
    vi.unstubAllEnvs();

    if (ORIGINAL_DATABASE_URL !== undefined) {
        process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
});

describe('databaseConfig', () => {
    it('parses every value at the boundary', async () => {
        vi.resetModules();
        withDatabaseUrl('postgresql://user:secret@db.example.com:5433/history');

        const { databaseConfig } = await import('./database.config');

        expect(databaseConfig).toEqual({
            connectionString: 'postgresql://user:secret@db.example.com:5433/history',
            poolMax: 10,
            idleTimeoutMs: 30_000,
            connectionTimeoutMs: 5_000,
            statementTimeoutMs: 10_000,
            lockTimeoutMs: 5_000,
            applicationName: 'buynotbuy',
        });
    });

    it('accepts the postgresql:// spelling as well as postgres://', async () => {
        vi.resetModules();
        withDatabaseUrl('postgresql://user:secret@localhost:5432/buynotbuy');

        const { databaseConfig } = await import('./database.config');

        expect(databaseConfig.connectionString).toBe(
            'postgresql://user:secret@localhost:5432/buynotbuy',
        );
    });

    it('has no default: a missing DATABASE_URL stops the process at import', async () => {
        vi.resetModules();
        clearDatabaseEnv();

        // A service that silently picks a database is a service that will
        // happily write somebody else's history.
        await expect(import('./database.config')).rejects.toThrow();
    });

    it('rejects a connection string that is not PostgreSQL', async () => {
        for (const url of [
            'mysql://user@localhost/history',
            'sqlite:///app/data/history.db',
            'localhost:5432',
        ]) {
            vi.resetModules();
            withDatabaseUrl(url);

            await expect(import('./database.config')).rejects.toThrow();
        }
    });

    it('rejects invalid numeric strings instead of becoming NaN at query time', async () => {
        for (const env of [
            { DB_POOL_MAX: 'abc' },
            { DB_POOL_MAX: '0' },
            { DB_POOL_MAX: '101' },
            { DB_IDLE_TIMEOUT_MS: 'abc' },
            { DB_CONNECT_TIMEOUT_MS: '-1' },
            { DB_STATEMENT_TIMEOUT_MS: 'abc' },
            { DB_LOCK_TIMEOUT_MS: '0' },
            { DB_APPLICATION_NAME: '' },
        ]) {
            vi.resetModules();
            withDatabaseUrl('postgresql://user@localhost:5432/buynotbuy');
            Object.assign(process.env, env);

            await expect(import('./database.config')).rejects.toThrow();
        }
    });

    it('does not leak an override into the next import', async () => {
        vi.resetModules();
        withDatabaseUrl('postgresql://first@localhost:5432/one');

        const { databaseConfig: first } = await import('./database.config');

        expect(first.connectionString).toBe('postgresql://first@localhost:5432/one');

        withDatabaseUrl('postgresql://second@localhost:5432/two');
        vi.resetModules();

        const { databaseConfig: second } = await import('./database.config');

        expect(second.connectionString).toBe('postgresql://second@localhost:5432/two');
    });
});
