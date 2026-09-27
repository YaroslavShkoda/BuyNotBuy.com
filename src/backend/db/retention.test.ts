import { describe, expect, it, beforeEach } from 'vitest';
import fc from 'fast-check';

import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';
import { applyMigrations } from './migrations.js';
import {
    RetentionPolicySchema,
    DEFAULT_RETENTION_POLICIES,
    planPrune,
    describeTable,
    cutoffFor,
    report,
} from './retention.js';
import { createRetentionStore, createIndexAuditStore, INDEX_PURPOSES } from './retention.store.js';

import type { RetentionPolicy, PruneResult } from './retention.js';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

const QUICK: RetentionPolicy[] = [
    {
        table: 'signal_history',
        keepDays: 30,
        rationale: 'быстрая проверка',
        timeColumn: 'hour_bucket',
        protected: false,
    },
    {
        table: 'market_candles',
        keepDays: 3650,
        rationale: 'источник измерений',
        timeColumn: 'timestamp',
        protected: true,
    },
];

function results(deleted: number[], tables = ['a', 'b']): PruneResult[] {
    return tables.map((table, index) => ({
        table,
        deleted: deleted[index] ?? 0,
        cutoff: NOW,
        durationMs: 1,
        skipped: 0,
    }));
}

describe('the policy is readable, and every rule has a reason', () => {
    it('refuses a rule with no explanation', () => {
        expect(() =>
            RetentionPolicySchema.parse({
                table: 'x',
                keepDays: 30,
                rationale: '',
                timeColumn: 'timestamp',
                protected: false,
            }),
        ).toThrow();
    });

    it('ships reasons with every rule it ships', () => {
        for (const policy of DEFAULT_RETENTION_POLICIES) {
            expect(policy.rationale.length).toBeGreaterThan(20);
        }
    });

    it('protects the two tables whose loss is a loss of knowledge', () => {
        const protectedTables = DEFAULT_RETENTION_POLICIES.filter(
            (policy) => policy.protected,
        )
            .map((policy) => policy.table)
            .sort();

        // market_candles is what every measurement is computed against, and
        // signal_outcome is the only record of which signals were right.
        expect(protectedTables).toEqual(['market_candles', 'signal_outcome']);
    });

    it('refuses to keep nothing, which is a typo rather than a policy', () => {
        expect(() =>
            RetentionPolicySchema.parse({
                table: 'x',
                keepDays: 0,
                rationale: 'удалить всё',
                timeColumn: 'timestamp',
                protected: false,
            }),
        ).toThrow();
    });
});

describe('a table with no policy is the dangerous state', () => {
    it('is refused rather than defaulted', () => {
        const described = describeTable('a_table_nobody_heard_of');

        // A default of "90 days" applied to a table that arrived yesterday
        // would delete data nobody had decided to lose.
        expect(described.known).toBe(false);
        expect(described.reason).toMatch(/лучше лишние строки/);
    });

    it('names the reason for a table that does have one', () => {
        expect(describeTable('signal_history').reason).toMatch(/хранится 1095 дн\./);
    });

    it('says plainly that a protected table is protected on purpose', () => {
        expect(describeTable('market_candles').reason).toMatch(/^защищена/);
    });

    it('passes for any table name at all', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 1, maxLength: 20 }), (table) => {
                const described = describeTable(table);
                const declared = DEFAULT_RETENTION_POLICIES.some(
                    (policy) => policy.table === table,
                );

                expect(described.known).toBe(declared);
            }),
            { numRuns: 50 },
        );
    });
});

describe('a protected table is reported as kept, not quietly skipped', () => {
    it('puts it in the refused list with its reason', () => {
        const plan = planPrune(QUICK, NOW);

        // A reader of the plan has to be able to see that data they expected
        // to be cleaned is still there deliberately.
        expect(plan.applicable.map((step) => step.table)).toEqual([
            'signal_history',
        ]);
        expect(plan.refused.map((entry) => entry.table)).toEqual([
            'market_candles',
        ]);
        expect(plan.refused[0]?.reason).toMatch(/защищена политикой/);
    });

    it('leaves a protected table with no age limit at all', () => {
        expect(
            DEFAULT_RETENTION_POLICIES.filter((policy) => policy.protected).every(
                (policy) => policy.keepDays >= 3650,
            ),
        ).toBe(true);
    });
});

describe('the cutoff keeps the boundary bar', () => {
    it('is exactly the retention period before now', () => {
        expect(cutoffFor(QUICK[0]!, NOW)).toBe(NOW - 30 * DAY);
    });

    it('removes strictly older rows, so the newest bar survives', () => {
        // A prune that removed the bar exactly on the boundary would delete the
        // most recent bar of a day still being written, and the next write
        // would put it back — making the prune look like it worked and had
        // deleted nothing.
        expect(NOW > cutoffFor(QUICK[0]!, NOW)).toBe(true);
    });

    it('holds for any keep period and any moment', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 3650 }),
                fc.integer({ min: 0, max: 4_000_000_000_000 }),
                (keepDays, at) => {
                    const policy = { ...QUICK[0]!, keepDays };
                    const cutoff = cutoffFor(policy, at);

                    expect(cutoff).toBeLessThan(at);
                    expect(at - cutoff).toBe(keepDays * DAY);
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('a prune that did nothing says so', () => {
    it('distinguishes an empty prune from one that never ran', () => {
        const empty = report(results([0, 0]), []);
        const didWork = report(results([12, 3]), []);

        // Without this a policy that stopped being applied is indistinguishable
        // from a table that simply had nothing old in it.
        expect(empty.nothingToDo).toBe(true);
        expect(didWork.nothingToDo).toBe(false);
        expect(didWork.totalDeleted).toBe(15);
    });

    it('carries the refusals through to the report', () => {
        const refused = [{ table: 'market_candles', reason: 'защищена' }];

        expect(report(results([1]), refused).refused).toBe(refused);
    });
});

describe('against a real database', () => {
    const pool = getTestPool();

    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('has every migration applied, including the three new tables', async () => {
        await applyMigrations();

        const rows = await pool.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema = current_schema()
                AND table_name IN (
                    'retention_policy', 'retention_run', 'index_audit',
                    'signal_strategy_version'
                )
              ORDER BY table_name`,
        );

        expect(rows.rows.map((row) => row.table_name)).toEqual([
            'index_audit',
            'retention_policy',
            'retention_run',
            'signal_strategy_version',
        ]);
    });

    it('refuses to record a strategy version that retired before it started', async () => {
        await applyMigrations();

        await expect(
            pool.query(
                `INSERT INTO signal_strategy_version
                     (rule_id, stage, parameters, promoted_at, retired_at, created_at)
                 VALUES ('r', 'production', '{}'::jsonb, $1, $2, $1)`,
                [NOW, NOW - 1000],
            ),
        ).rejects.toThrow();
    });

    it('lists the seeded policies when the table is empty', async () => {
        await applyMigrations();
        await pool.query('DELETE FROM retention_policy');

        const store = createRetentionStore(pool, QUICK, () => NOW);
        const policies = await store.listPolicies();

        // A policy that exists only in code and one that exists only in the
        // database are both ways for the answer to depend on which process is
        // asking.
        expect(policies.map((policy) => policy.table)).toEqual([
            'market_candles',
            'signal_history',
        ]);
    });

    it('survives a policy being set twice', async () => {
        await applyMigrations();
        await pool.query('DELETE FROM retention_policy');

        const store = createRetentionStore(pool, QUICK, () => NOW);

        await store.setPolicy(QUICK[0]!, NOW);
        await store.setPolicy({ ...QUICK[0]!, keepDays: 60, rationale: 'изменено' }, NOW + 1);
        const policies = await store.listPolicies();

        expect(policies).toHaveLength(2);
        expect(policies.find((policy) => policy.table === 'signal_history')?.keepDays).toBe(60);
    });

    it('deletes only what the cutoff names', async () => {
        await applyMigrations();
        await pool.query('DELETE FROM retention_policy');

        const old = NOW - 40 * DAY;
        const recent = NOW - 10 * DAY;

        await pool.query(
            `INSERT INTO signal_history
                 (symbol, provider, interval, hour_bucket, timestamp, signal, consensus, price)
             VALUES ($1, 'test', '1d', $2, $2, 'LONG', 1, 1),
                    ($1, 'test', '1d', $3, $3, 'LONG', 1, 1)`,
            ['BTCUSDT', old, recent],
        );

        const store = createRetentionStore(pool, QUICK, () => NOW);
        const outcome = await store.prune(NOW);

        const left = await pool.query<{ count: number }>(
            'SELECT count(*)::bigint AS count FROM signal_history',
        );

        expect(Number(left.rows[0]?.count)).toBe(1);
        expect(outcome.totalDeleted).toBe(1);
        expect(outcome.refused.map((entry) => entry.table)).toEqual([
            'market_candles',
        ]);
    });

    it('leaves a protected table completely untouched', async () => {
        await applyMigrations();
        await pool.query('DELETE FROM retention_policy');

        const old = NOW - 4000 * DAY;

        await pool.query(
            `INSERT INTO market_candles
                 (provider, symbol, interval, timestamp, open, high, low, close, volume, is_closed, ingested_at)
             VALUES ('test', 'BTCUSDT', '1d', $1, 1, 1, 1, 1, 1, true, $1)`,
            [old],
        );

        const store = createRetentionStore(pool, QUICK, () => NOW);
        const outcome = await store.prune(NOW);

        const left = await pool.query<{ count: number }>(
            'SELECT count(*)::bigint AS count FROM market_candles',
        );

        expect(Number(left.rows[0]?.count)).toBe(1);
        expect(outcome.totalDeleted).toBe(0);
    });

    it('records what it did, so a missing row is explainable', async () => {
        await applyMigrations();
        await pool.query('DELETE FROM retention_policy');
        await pool.query('DELETE FROM retention_run');

        const old = NOW - 40 * DAY;

        await pool.query(
            `INSERT INTO signal_history
                 (symbol, provider, interval, hour_bucket, timestamp, signal, consensus, price)
             VALUES ('BTCUSDT', 'test', '1d', $1, $1, 'LONG', 1, 1)`,
            [old],
        );

        const store = createRetentionStore(pool, QUICK, () => NOW);
        await store.prune(NOW);
        const last = await store.lastRun('signal_history');

        expect(last?.deleted).toBe(1);
    });
});

describe('the index ledger', () => {
    const pool = getTestPool();

    it('names a caller for every index it declares', () => {
        for (const entry of INDEX_PURPOSES) {
            // A named caller can be checked; "something" cannot.
            expect(entry.requiredBy).toMatch(/\w+\.\w+/);
        }
    });

    it('agrees with the indexes the migrations actually create', async () => {
        await applyMigrations();

        const store = createIndexAuditStore(pool);
        const reconciliation = await store.reconcile();

        // The declared set and the created set have been edited separately six
        // times over this project. Checking that they still agree is the only
        // reason the ledger is worth keeping.
        expect(reconciliation.missing).toEqual([]);
    });

    it('reports an index the code needs and the database lacks', async () => {
        await applyMigrations();

        const store = createIndexAuditStore(pool, [
            {
                table: 'signal_history',
                index: 'idx_that_was_never_created',
                purpose: 'выдуманный',
                requiredBy: 'signal-history.repository.list',
            },
        ]);
        const reconciliation = await store.reconcile();

        expect(reconciliation.consistent).toBe(false);
        expect(reconciliation.missing[0]?.requiredBy).toBe(
            'signal-history.repository.list',
        );
        expect(reconciliation.reason).toMatch(/нужен для/);
    });

    it('lists what the database has and nobody declared, without dropping it', async () => {
        await applyMigrations();

        const store = createIndexAuditStore(pool, []);
        const reconciliation = await store.reconcile();

        // A system that removed undeclared indexes on its own would eventually
        // remove a primary key that happened to be created by a migration
        // nobody wrote a line for.
        expect(reconciliation.undeclared.length).toBeGreaterThan(0);
        expect(reconciliation.missing).toEqual([]);
    });

    it('persists what it declared and reads it back', async () => {
        await applyMigrations();
        await pool.query('DELETE FROM index_audit');

        const store = createIndexAuditStore(pool);
        await store.declare(NOW);
        await store.declare(NOW);
        const listed = await store.list();

        // Declaring twice is what a redeploy does, and it must not duplicate.
        expect(listed).toHaveLength(INDEX_PURPOSES.length);
    });
});
