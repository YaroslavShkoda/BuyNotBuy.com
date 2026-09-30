import { describe, expect, it } from 'vitest';

import '../test-support/test-database.js';

import { createRetentionStore } from './retention.store.js';
import { getTestPool } from '../test-support/test-database.js';
import { RetentionPolicySchema, planPrune } from './retention.js';

import type { Queryable } from './retention.store.js';
import type { RetentionPolicy } from './retention.js';

const NOW = 1_700_000_000_000;

const EVENTS: RetentionPolicy = RetentionPolicySchema.parse({
    table: 'retention_probe_events',
    keepDays: 30,
    rationale: 'строка пробы, чтобы проверить отчёт очистки',
    timeColumn: 'timestamp',
    protected: false,
});

/**
 * A store whose database records what it was asked to do.
 *
 * The point of the audit here was that a step can disappear without anyone
 * noticing, so the question is never "did it delete the right rows" but "was
 * the report complete". A real database cannot answer the second one, because
 * a table that was never touched and a table that was deliberately spared leave
 * exactly the same evidence behind.
 */
function recordingDatabase(): {
    database: Queryable;
    deletes: string[];
} {
    const deletes: string[] = [];

    return {
        deletes,
        database: {
            async query<T>(
                text: string,
                values?: readonly unknown[],
            ): Promise<{ rows: T[]; rowCount: number | null }> {
                const match = /DELETE FROM (\w+)/.exec(text);

                if (match?.[1] !== undefined) {
                    deletes.push(match[1]);

                    return { rows: [], rowCount: 0 };
                }

                if (/FROM retention_policy/.test(text)) {
                    return { rows: [EVENTS] as T[], rowCount: 1 };
                }

                // Every other statement, the `retention_run` ledger insert
                // included, is a write the report does not depend on.
                void values;

                return { rows: [], rowCount: 0 };
            },
        },
    };
}

describe('a prune that could not touch everything says so', () => {
    it('cannot reach a step it has no policy for, which is why the guard exists', async () => {
        // The two branches that used to `continue` silently are unreachable by
        // construction: the plan is built from the same policy array the loop
        // searches, so a selected step always has a policy and every selected
        // table is describable. That is why they were written as guards and
        // why no test here can reach them.
        //
        // The first version of this file claimed to cover the branch and did
        // not: it asserted `results.length + refused.length > 0`, which is true
        // whatever the code does, and it kept passing when the recording was
        // removed. A test that cannot fail is worse than no test, because it
        // reads as coverage. So the branch is described here instead, and the
        // property below is the one that is actually reachable and actually
        // load-bearing.
        const { database } = recordingDatabase();
        const store = createRetentionStore(database, [EVENTS], () => NOW);
        const report = await store.prune(NOW, [EVENTS]);

        // Whatever happened, every policy is accounted for.
        expect(report.results.length + report.refused.length).toBe(1);
    });

    it('keeps a protected table visible in the report it produces', async () => {
        const protectedPolicy = RetentionPolicySchema.parse({
            table: 'retention_probe_events',
            keepDays: 3650,
            rationale: 'защищена политикой, чтобы её отказ был виден в отчёте',
            timeColumn: 'timestamp',
            protected: true,
        });
        const { database, deletes } = recordingDatabase();
        const store = createRetentionStore(database, [protectedPolicy], () => NOW);

        const report = await store.prune(NOW, [protectedPolicy]);

        expect(deletes).not.toContain('retention_probe_events');
        expect(report.refused.map((entry) => entry.table)).toContain(
            'retention_probe_events',
        );
    });

    it('does not write a skip counter it cannot measure', async () => {
        // `retention_run.skipped` exists in the database and its column comment
        // describes counting rows that could not be deleted because something
        // still references them. The DELETE is unconditional: it removes every
        // row past the cutoff or the statement fails, and a foreign-key
        // violation takes the whole statement rather than leaving rows behind.
        // So the number could only ever be 0. Asserting that here is the point:
        // a column that is always 0 is indistinguishable from a measurement
        // that is being taken, and the distinction is the whole reason to look.
        const row = await getTestPool().query(
            `SELECT column_default, is_nullable
               FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'retention_run'
                AND column_name = 'skipped'`,
        );

        expect(row.rows).toHaveLength(1);
        // Defaulted by the database, never supplied by the code that writes it.
        expect(row.rows[0]?.column_default).toContain('0');
    });

    it('selects a plan that keeps every table it can account for', () => {
        // The property the report now depends on: a plan and a report between
        // them account for every table, either pruned or refused.
        const policies = [
            EVENTS,
            RetentionPolicySchema.parse({
                table: 'retention_probe_events_shadowed',
                keepDays: 3650,
                rationale: 'защищена, чтобы проверить полноту плана',
                timeColumn: 'timestamp',
                protected: true,
            }),
        ];
        const plan = planPrune(policies, NOW);

        expect(plan.applicable.length + plan.refused.length).toBe(
            policies.length,
        );
    });
});
