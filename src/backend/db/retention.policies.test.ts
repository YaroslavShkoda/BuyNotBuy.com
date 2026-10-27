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

    it('prunes expired history across assets, venues and intervals without losing fresh series or protected evidence', async () => {
        await pool.query('DELETE FROM retention_policy');
        const store = createRetentionStore(pool);
        const repository = createSignalHistoryRepository({ maxEntries: 720 });
        const now = 1_800_000_000_000;
        // Default retention is 1095 days. These are 1096 and 1 day old;
        // every series deliberately shares its timestamps and hour buckets.
        const expired = 1_705_305_600_000;
        const fresh = 1_799_913_600_000;
        const ancient = 1_000_000_000_000;
        const series = ['BTCUSDT', 'ETHUSDT'].flatMap(symbol =>
            ['binance', 'bitget'].flatMap(provider =>
                (['1h', '4h'] as const).map(interval => ({ symbol, provider, interval })),
            ),
        );
        for (const [index, market] of series.entries()) {
            for (const timestamp of [expired, fresh]) {
                await repository.record({
                    ...market, timestamp, signal: 'LONG', consensus: 60, price: 100 + index,
                });
            }
            await pool.query(
                `INSERT INTO market_candles
                     (symbol, provider, interval, timestamp, open, high, low, close, volume, is_closed, ingested_at)
                 VALUES ($1, $2, $3, $4, 1, 1, 1, 1, 1, true, $4)`,
                [market.symbol, market.provider, market.interval, ancient],
            );
            await pool.query(
                `INSERT INTO signal_outcome
                     (symbol, provider, interval, direction, verdict, horizon_bars,
                      entry_timestamp, entry_price, created_at, updated_at)
                 VALUES ($1, $2, $3, 'LONG', 'correct', 24, $4, 1, $4, $4)`,
                [market.symbol, market.provider, market.interval, ancient],
            );
        }
        const before = await pool.query<{ timestamp: number; hour_bucket: number }>(
            'SELECT timestamp, hour_bucket FROM signal_history',
        );
        expect(before.rows).toHaveLength(16);
        expect(before.rows.every(row => row.hour_bucket === Math.floor(row.timestamp / 3_600_000))).toBe(true);
        const candlesBefore = await pool.query('SELECT * FROM market_candles ORDER BY symbol, provider, interval');
        const outcomesBefore = await pool.query('SELECT * FROM signal_outcome ORDER BY symbol, provider, interval');
        expect(candlesBefore.rows).toHaveLength(8);
        expect(outcomesBefore.rows).toHaveLength(8);

        // No explicit policy argument: exercise the production default-policy
        // lookup, not a corrected test policy that could hide a broken seed.
        const report = await store.prune(now);
        for (const [index, market] of series.entries()) {
            const remaining = await repository.list(market.symbol, 10, undefined, market);
            expect(remaining).toHaveLength(1);
            expect(remaining[0]).toMatchObject({
                ...market, timestamp: fresh, signal: 'LONG', consensus: 60, price: 100 + index,
            });
        }
        expect(report.totalDeleted).toBe(8);
        expect(report.results.find(result => result.table === 'signal_history')?.deleted).toBe(8);
        expect(report.refused.map(entry => entry.table).sort()).toEqual(['market_candles', 'signal_outcome']);
        expect((await pool.query('SELECT * FROM market_candles ORDER BY symbol, provider, interval')).rows).toEqual(candlesBefore.rows);
        expect((await pool.query('SELECT * FROM signal_outcome ORDER BY symbol, provider, interval')).rows).toEqual(outcomesBefore.rows);
        const repeated = await store.prune(now);
        expect(repeated.totalDeleted).toBe(0);
        expect(repeated.nothingToDo).toBe(true);
        expect((await pool.query('SELECT timestamp FROM signal_history')).rows).toHaveLength(8);
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
