import { describe, expect, it } from 'vitest';
import { getTestPool } from '../test-support/test-database.js';
import { DEFAULT_RETENTION_POLICIES } from './retention.js';

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
