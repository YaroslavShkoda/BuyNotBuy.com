import { describe, expect, it } from 'vitest';

import { closePool, getPool, isPoolOpen, query, withTransaction } from './pool';

describe('pool', () => {
    it('reads and writes through one connection', async () => {
        await query('CREATE TABLE IF NOT EXISTS pool_probe (id INTEGER PRIMARY KEY)');
        await query('TRUNCATE pool_probe');

        await query('INSERT INTO pool_probe (id) VALUES ($1)', [1]);

        const result = await query<{ total: number }>(
            'SELECT COUNT(*) AS total FROM pool_probe',
        );

        expect(result.rows[0]?.total).toBe(1);
    });

    it('returns BIGINT columns as numbers, not as strings', async () => {
        await query('CREATE TABLE IF NOT EXISTS pool_probe_bigint (value BIGINT)');
        await query('TRUNCATE pool_probe_bigint');

        // 1_700_000_000_123 — a millisecond timestamp, well inside
        // Number.MAX_SAFE_INTEGER but well outside int32.
        const stored = 1_700_000_000_123;

        await query('INSERT INTO pool_probe_bigint (value) VALUES ($1)', [stored]);

        const result = await query<{ value: number }>(
            'SELECT value FROM pool_probe_bigint',
        );

        // node-postgres hands int8 back as text by default. The repositories
        // compare timestamps with `<` and subtract them, so a string here would
        // be a comparison that silently means something else.
        expect(result.rows[0]?.value).toBe(stored);
        expect(typeof result.rows[0]?.value).toBe('number');
    });

    it('commits the work handed to withTransaction', async () => {
        await query('CREATE TABLE IF NOT EXISTS pool_probe_tx (id INTEGER PRIMARY KEY)');
        await query('TRUNCATE pool_probe_tx');

        await withTransaction(async (client) => {
            await client.query('INSERT INTO pool_probe_tx (id) VALUES ($1)', [1]);
        });

        const result = await query<{ total: number }>(
            'SELECT COUNT(*) AS total FROM pool_probe_tx',
        );

        expect(result.rows[0]?.total).toBe(1);
    });

    it('rolls back and rethrows when the work throws', async () => {
        await query('CREATE TABLE IF NOT EXISTS pool_probe_tx (id INTEGER PRIMARY KEY)');
        await query('TRUNCATE pool_probe_tx');

        await expect(
            withTransaction(async (client) => {
                await client.query('INSERT INTO pool_probe_tx (id) VALUES ($1)', [1]);

                throw new Error('work failed');
            }),
        ).rejects.toThrow('work failed');

        const result = await query<{ total: number }>(
            'SELECT COUNT(*) AS total FROM pool_probe_tx',
        );

        // A half-applied batch is the case that matters: a reading whose
        // indicators disagree with each other would settle horizons off the
        // wrong price.
        expect(result.rows[0]?.total).toBe(0);
    });

    it('applies the configured statement timeout to a pooled connection', async () => {
        const result = await query<{ statement_timeout: string }>(
            'SHOW statement_timeout',
        );

        expect(result.rows[0]?.statement_timeout).toBe('10s');

        const locks = await query<{ lock_timeout: string }>('SHOW lock_timeout');

        expect(locks.rows[0]?.lock_timeout).toBe('5s');
    });

    it('reopens after being closed, so a later start is not a dead process', async () => {
        expect(isPoolOpen()).toBe(true);

        await closePool();

        expect(isPoolOpen()).toBe(false);

        const result = await query<{ one: number }>('SELECT 1 AS one');

        expect(result.rows[0]?.one).toBe(1);
        expect(isPoolOpen()).toBe(true);
    });

    it('reports a closed pool as needing no close', async () => {
        await closePool();

        // Shutdown runs more than once (SIGINT then SIGTERM), and a second
        // close of a live pool is what would throw here.
        await expect(closePool()).resolves.toBeUndefined();
        expect(getPool()).toBeDefined();
    });
});
