import { getPool } from './pool.js';
import {
    DEFAULT_RETENTION_POLICIES,
    describeTable,
    planPrune,
    report,
    RetentionPolicySchema,
} from './retention.js';

import type { RetentionPolicy, PruneReport, PruneResult } from './retention.js';

/**
 * The pruner, the index ledger, and the people who read them.
 *
 * The database is injected rather than imported, for the same reason as every
 * other repository here: a test that needs a real database should be able to
 * have one, and a test that needs to prove a delete did not happen should not
 * have to be satisfied by a mock that agrees with it.
 */

export interface Queryable {
    query: <T>(
        text: string,
        values?: readonly unknown[],
    ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

// Deliberately not validating `retention_run` rows.
//
// The schema this replaces required a `skipped` column that the INSERT below
// never wrote and never will, because the DELETE either removes every row past
// the cutoff or fails the statement outright. Validating a column nothing
// populates means every parse either trusted a database default or threw for a
// value the code had never written. There is no consumer of the row's own
// fields here — `lastRun` selects the two it needs and nothing else — so
// nothing is lost by leaving the shape unvalidated.

export interface RetentionStore {
    listPolicies(): Promise<RetentionPolicy[]>;
    setPolicy(policy: RetentionPolicy, now: number): Promise<void>;
    prune(now: number, policies?: readonly RetentionPolicy[]): Promise<PruneReport>;
    lastRun(table: string): Promise<{ deleted: number; at: number } | null>;
}

export function createRetentionStore(
    database: Queryable,
    seed: readonly RetentionPolicy[] = DEFAULT_RETENTION_POLICIES,
    now: () => number = () => Date.now(),
): RetentionStore {
    return {
        async listPolicies() {
            const rows = await database.query<{
                table_name: string;
                keep_days: number;
                rationale: string;
                updated_at: number;
            }>(
                `SELECT table_name, keep_days, rationale, updated_at
                   FROM retention_policy
                  ORDER BY table_name`,
            );

            // A table in the seed but missing from the database is filled in
            // rather than left out: a policy that exists only in code and a
            // policy that exists only in the database are both ways for the
            // answer to depend on which process is asking.
            const stored = rows.rows.map((row) =>
                RetentionPolicySchema.parse({
                    table: row.table_name,
                    keepDays: row.keep_days,
                    rationale: row.rationale,
                    timeColumn:
                        seed.find((policy) => policy.table === row.table_name)
                            ?.timeColumn ?? 'timestamp',
                    protected:
                        seed.find((policy) => policy.table === row.table_name)
                            ?.protected ?? false,
                }),
            );
            const storedNames = new Set(stored.map((policy) => policy.table));
            const missing = seed.filter(
                (policy) => !storedNames.has(policy.table),
            );

            return [...stored, ...missing].sort((a, b) =>
                a.table.localeCompare(b.table),
            );
        },

        async setPolicy(policy, at) {
            await database.query(
                `INSERT INTO retention_policy (table_name, keep_days, rationale, updated_at)
                      VALUES ($1, $2, $3, $4)
                 ON CONFLICT (table_name)
                 DO UPDATE SET keep_days = EXCLUDED.keep_days,
                               rationale  = EXCLUDED.rationale,
                               updated_at = EXCLUDED.updated_at`,
                [policy.table, policy.keepDays, policy.rationale, at],
            );
        },

        async prune(at, policies) {
            const effective = policies ?? (await this.listPolicies());
            const plan = planPrune(effective, at);
            const results: PruneResult[] = [];
            // Refusals found while running, as opposed to the ones the plan
            // already knew about. Kept apart so the two are not confused: a
            // reader asking "did the plan know this was protected?" deserves a
            // different answer from one asking "what did the pruner refuse?".
            const refused: { table: string; reason: string }[] = [];

            for (const step of plan.applicable) {
                const policy = effective.find(
                    (candidate) => candidate.table === step.table,
                );

                if (policy === undefined) {
                    // Reported rather than dropped. The plan is built from these
                    // same policies, so this cannot happen today — and a step
                    // that vanishes leaves a report that looks complete, which
                    // is the one shape of wrong that nothing downstream can
                    // notice. Same rule as the unknown-table branch below.
                    refused.push({
                        table: step.table,
                        reason:
                            `у ${step.table} нет политики хранения среди ` +
                            'применяемых, хотя план её отобрал',
                    });

                    continue;
                }

                const known = describeTable(step.table, effective);

                if (!known.known) {
                    // `describeTable` has already written down exactly why this
                    // table was not pruned. Throwing that away and carrying on
                    // was the module contradicting its own rule — protected
                    // tables appear in `refused` with a reason, and an unknown
                    // one is refused for the same reason and was disappearing
                    // instead.
                    refused.push({ table: step.table, reason: known.reason });

                    continue;
                }

                const startedAt = Date.now();
                const deleted = await database.query(
                    `DELETE FROM ${policy.table} WHERE ${policy.timeColumn} < $1`,
                    [step.cutoff],
                );
                const durationMs = Date.now() - startedAt;
                const removed = deleted.rowCount ?? 0;

                // Written after the delete rather than in the same transaction
                // as it: the point of the row is to survive a crash part-way
                // through a prune, and a log that rolls back with the work it
                // describes leaves no evidence that anything happened.
                await database.query(
                    `INSERT INTO retention_run
                         (table_name, started_at, finished_at, cutoff, deleted_rows, duration_ms)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [step.table, startedAt, Date.now(), step.cutoff, removed, durationMs],
                );

                results.push({
                    table: step.table,
                    deleted: removed,
                    cutoff: step.cutoff,
                    durationMs,
                });
            }

                return report(results, [...plan.refused, ...refused]);
        },

        async lastRun(table) {
            const rows = await database.query<{
                finished_at: number;
                deleted_rows: number;
            }>(
                `SELECT finished_at, deleted_rows
                   FROM retention_run
                  WHERE table_name = $1
                  ORDER BY finished_at DESC
                  LIMIT 1`,
                [table],
            );

            const row = rows.rows[0];

            return row === undefined
                ? null
                : { deleted: row.deleted_rows, at: row.finished_at };
        },
    };
}

/** The declared purpose of every index this schema relies on. */
export const INDEX_PURPOSES = [
    {
        table: 'signal_history',
        index: 'signal_history_pkey',
        purpose: 'Первичный ключ серии: чтение истории по символу и часу',
        requiredBy: 'signal-history.repository.list',
    },
    {
        table: 'signal_history',
        index: 'idx_signal_history_series_time',
        purpose:
            'Чтение серии по времени: график истории и окно для расчёта',
        requiredBy: 'signal-history.repository.list',
    },
    {
        table: 'signal_history',
        index: 'idx_signal_history_regime',
        purpose: 'Разрезание истории по режиму рынка для сравнительной статистики',
        requiredBy: 'regime-performance.byRegime',
    },
    {
        table: 'signal_outcome',
        index: 'idx_signal_outcome_series',
        purpose: 'Итоги по серии: корзины уверенности и разбивка по индикаторам',
        requiredBy: 'performance.computeMetrics',
    },
    {
        table: 'signal_outcome',
        index: 'idx_signal_outcome_regime',
        purpose: 'Сравнение исходов между режимами рынка',
        requiredBy: 'regime-performance.byRegime',
    },
    {
        table: 'signal_outcome',
        index: 'idx_signal_outcome_unresolved',
        purpose: 'Сканирование неразрешённых на каждом запуске расчёта',
        requiredBy: 'outcome.repository.unresolved',
    },
    {
        table: 'signal_state',
        index: 'signal_state_pkey',
        purpose: 'Живая позиция по ключу серии',
        requiredBy: 'lifecycle.repository.getLive',
    },
    {
        table: 'signal_transition',
        index: 'idx_signal_transition_state',
        purpose: 'Журнал переходов конкретной позиции, для объяснения закрытия',
        requiredBy: 'lifecycle.repository.transitions',
    },
] as const;

export interface IndexAuditStore {
    declare(now: number): Promise<void>;
    list(): Promise<{ table: string; index: string; purpose: string; requiredBy: string }[]>;
    reconcile(): Promise<IndexReconciliation>;
}

export interface IndexReconciliation {
    /** Declared here and missing from the database. */
    readonly missing: readonly { table: string; index: string; requiredBy: string }[];
    /** Present in the database and declared nowhere. */
    readonly undeclared: readonly { table: string; index: string }[];
    readonly consistent: boolean;
    readonly reason: string;
}

export function createIndexAuditStore(
    database: Queryable,
    declared: readonly { table: string; index: string; purpose: string; requiredBy: string }[] = INDEX_PURPOSES,
): IndexAuditStore {
    return {
        async declare(now) {
            for (const entry of declared) {
                await database.query(
                    `INSERT INTO index_audit (table_name, index_name, purpose, required_by, created_at)
                          VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (table_name, index_name)
                     DO UPDATE SET purpose = EXCLUDED.purpose,
                                   required_by = EXCLUDED.required_by`,
                    [entry.table, entry.index, entry.purpose, entry.requiredBy, now],
                );
            }
        },

        async list() {
            const rows = await database.query<{
                table_name: string;
                index_name: string;
                purpose: string;
                required_by: string;
            }>(
                `SELECT table_name, index_name, purpose, required_by
                   FROM index_audit
                  ORDER BY table_name, index_name`,
            );

            return rows.rows.map((row) => ({
                table: row.table_name,
                index: row.index_name,
                purpose: row.purpose,
                requiredBy: row.required_by,
            }));
        },

        /**
         * Compares what the code needs with what the database has.
         *
         * The interesting half is `undeclared`, and it is reported rather than
         * dropped. A system that removed undeclared indexes on its own would
         * eventually remove a primary key that happened to be created by a
         * migration nobody wrote a line for — and small production traffic is
         * not evidence that an index is unused, it is evidence that few people
         * have used the system.
         */
        async reconcile() {
            const rows = await database.query<{ tablename: string; indexname: string }>(
                `SELECT tablename, indexname
                   FROM pg_indexes
                  WHERE schemaname = current_schema()
                    AND tablename NOT IN (
                        'schema_migrations', 'pg_catalog'
                    )`,
            );

            const present = new Set(
                rows.rows.map((row) => `${row.tablename}.${row.indexname}`),
            );
            const known = new Set(
                declared.map((entry) => `${entry.table}.${entry.index}`),
            );

            const missing = declared
                .filter((entry) => !present.has(`${entry.table}.${entry.index}`))
                .map((entry) => ({
                    table: entry.table,
                    index: entry.index,
                    requiredBy: entry.requiredBy,
                }));
            const undeclared = rows.rows
                .filter(
                    (row) => !known.has(`${row.tablename}.${row.indexname}`),
                )
                .map((row) => ({ table: row.tablename, index: row.indexname }));

            return {
                missing,
                undeclared,
                consistent: missing.length === 0,
                reason:
                    missing.length === 0
                        ? 'все объявленные индексы на месте'
                        : `объявлены, но отсутствуют: ${missing
                              .map((entry) => `${entry.table}.${entry.index} (нужен для ${entry.requiredBy})`)
                              .join(', ')}`,
            };
        },
    };
}

let shared: RetentionStore | null = null;

/**
 * The store production uses, built here rather than by the caller.
 *
 * **This module is in `db/`, and that is the whole reason the singleton lives
 * here.** My first wiring had the server import the pool itself, which put a
 * `db/pool.js` import in a domain file and failed the audit — and the audit's
 * own note says its one exemption is "not a general one", because a second
 * exemption added to make one's own change legal is a hole wearing a reason.
 *
 * So the composition happens in the layer allowed to do it, and the server asks
 * for the store the same way it asks every other repository.
 */
export function getRetentionStore(): RetentionStore {
    shared ??= createRetentionStore(getPool());

    return shared;
}
