import { describe, expect, it } from 'vitest';
import { createSignalHistoryRepository } from '../history/signal-history.repository.js';
import { getTestPool } from '../test-support/test-database.js';
import { cutoffFor, DEFAULT_RETENTION_POLICIES } from './retention.js';
import { createRetentionStore } from './retention.store.js';

/**
 * Every policy's time column is a real column.
 *
 * **This test exists because one of them was not.** The `signal_transition`
 * policy named `at`; the table has `candle_timestamp` and `created_at`. Nothing
 * caught it for as long as the policy existed, because nothing ever ran a
 * prune — a policy that is never executed is a comment with a schema in it, and
 * the only thing that made the difference was wiring it up and watching the
 * first cycle throw with 42703.
 *
 * Now that it runs, the next typo would be found on a live cycle, where it
 * belongs to neither a test nor a person. Checked against the real schema here
 * instead, where the failure is a name and a policy rather than a stack trace
 * from a running service.
 */
describe('retention policies describe tables that exist', () => {
    const pool = getTestPool();

    it.each([false, true])('keeps real fresh/boundary history and deletes only expired history (stored override: %s)', async (storedOverride) => {
        await pool.query("DELETE FROM retention_policy WHERE table_name = 'signal_history'");
        const store = createRetentionStore(pool);
        const seed = DEFAULT_RETENTION_POLICIES.find(policy => policy.table === 'signal_history');
        if (seed === undefined) throw new Error('signal_history policy missing');
        const now = 1_800_000_000_000;
        if (storedOverride) {
            // Persisted policies contain keepDays/rationale, not a time column;
            // an existing installation must pick up the corrected code seed.
            await store.setPolicy({ ...seed, keepDays: 30 }, now);
        }
        const policy = (await store.listPolicies()).find(candidate => candidate.table === 'signal_history');
        if (policy === undefined) throw new Error('signal_history policy missing');
        const cutoff = cutoffFor(policy, now);
        const entries = [
            { provider: 'retention_fresh', timestamp: now },
            { provider: 'retention_expired', timestamp: cutoff - 1 },
            { provider: 'retention_boundary', timestamp: cutoff },
            { provider: 'retention_after_boundary', timestamp: cutoff + 1 },
        ];
        const repository = createSignalHistoryRepository({ maxEntries: 720 });
        for (const entry of entries) {
            await repository.record({ ...entry, symbol: 'BTCUSDT', interval: '1h', signal: 'NEUTRAL', consensus: 50, price: 1 });
        }
        const before = await pool.query<{ timestamp: number; hour_bucket: number }>('SELECT timestamp, hour_bucket FROM signal_history');
        expect(before.rows).toHaveLength(4);
        expect(before.rows.every(row => row.hour_bucket === Math.floor(row.timestamp / 3_600_000))).toBe(true);
        const report = await store.prune(now, [policy]);
        const remaining = await pool.query<{ provider: string }>('SELECT provider FROM signal_history ORDER BY provider');
        expect(remaining.rows.map(row => row.provider)).toEqual(['retention_after_boundary', 'retention_boundary', 'retention_fresh']);
        expect(report.totalDeleted).toBe(1);
    });

    it.each(DEFAULT_RETENTION_POLICIES)(
        '$table is pruned by $timeColumn, which exists',
        async ({ table, timeColumn }) => {
            // A real query rather than a catalogue lookup. `information_schema`
            // reports only the current search path, and the test database gives
            // every test file its own schema — so a catalogue check answered
            // "no such column" for all five policies including ones that are
            // demonstrably there.
            await expect(
                pool.query(`SELECT ${timeColumn} FROM ${table} LIMIT 0`),
            ).resolves.toBeDefined();
        },
        30_000,
    );

    it('refuses to prune the evidence chain', async () => {
        // The two tables every historical claim depends on: the bars the claims
        // were measured against, and the only place that says which signals
        // turned out right. Losing either is not losing detail.
        const protectedTables = DEFAULT_RETENTION_POLICIES.filter(
            (policy) => policy.protected,
        ).map((policy) => policy.table);

        expect(protectedTables).toContain('market_candles');
        expect(protectedTables).toContain('signal_outcome');
    });
});
