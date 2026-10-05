// For its side effects, and before anything imports the pool modules: this
// file's schema has to exist — and own the connection string — before
// `database.config` reads the environment.
import '../../test-support/test-database.js';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRetentionStore } from '../../db/retention.store.js';
import { getTestPool } from '../../test-support/test-database.js';
import { PostgresRateLimiter } from './rate-limit.js';

/**
 * The part that made the counter worth moving: what two instances see.
 *
 * The unit tests script the upsert's answer; only a real database can prove
 * that two live writers asking one row serialize, that the count does not
 * split into two half-budgets, and that the row the policy machinery prunes
 * is the row this limiter wrote.
 */

const WINDOW_MS = 60_000;

let first: PostgresRateLimiter;
let second: PostgresRateLimiter;

function limiter(max: number): PostgresRateLimiter {
    return new PostgresRateLimiter({
        max,
        windowMs: WINDOW_MS,
        database: getTestPool(),
    });
}

beforeAll(() => {
    first = limiter(2);
    second = limiter(2);
});

beforeEach(async () => {
    await getTestPool().query('DELETE FROM rate_limit_window');
});

describe('PostgresRateLimiter, against the real database', () => {
    it('shares one budget between the instances that ask it', async () => {
        await expect(first.consume('10.0.0.1')).resolves.toMatchObject({
            allowed: true,
            remaining: 1,
        });

        // The "second process" sees the first one's spend, which is the whole
        // point: in process memory this request would have started from a
        // fresh counter and answered allowed with the full allowance back.
        await expect(second.consume('10.0.0.1')).resolves.toMatchObject({
            allowed: true,
            remaining: 0,
        });

        await expect(first.consume('10.0.0.1')).resolves.toMatchObject({
            allowed: false,
            remaining: 0,
        });

        // And a different client is a different row, untouched by the first.
        await expect(second.consume('10.0.0.2')).resolves.toMatchObject({
            allowed: true,
            remaining: 1,
        });
    });

    it('lands concurrent writers on the same total', async () => {
        const shared = limiter(300);

        const decisions = await Promise.all(
            Array.from({ length: 5 }, () => shared.consume('10.0.0.9')),
        );

        // Five concurrent upserts, no lost update: the row lock between the
        // insert-conflict and the increment is the concurrency control, and
        // the read-backs must sum to what one row now holds.
        expect(decisions).toHaveLength(5);

        const row = await getTestPool().query<{
            count: number;
            window_start: number;
        }>(
            'SELECT count, window_start FROM rate_limit_window WHERE bucket = $1',
            ['10.0.0.9'],
        );

        expect(row.rows[0]?.count).toBe(5);
        expect(row.rows[0]?.window_start).toBe(
            Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS,
        );
    });

    it('writes a window the retention machinery can sweep', async () => {
        const sweeper = limiter(300);

        await sweeper.consume('10.0.0.7');

        // A window that ended two days ago. Nothing joins it again — the
        // conflict target is (bucket, window_start) — so keeping it is
        // forensics, and the policy says one day.
        await getTestPool().query(
            'UPDATE rate_limit_window SET window_start = window_start - $1',
            [2 * 86_400_000],
        );

        const store = createRetentionStore(getTestPool());
        const report = await store.prune(Date.now());

        const swept = report.results.find(
            (result) => result.table === 'rate_limit_window',
        );

        expect(swept?.deleted).toBe(1);
    });
});
