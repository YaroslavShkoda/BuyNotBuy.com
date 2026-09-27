import { z } from 'zod';

/**
 * What the system is willing to forget, and what it refuses to.
 *
 * Retention is not a storage decision. Everything this project measures —
 * accuracy, calibration, performance by regime — is computed from rows in
 * these tables, and deleting them does not make a number smaller, it makes the
 * number impossible to recompute. So the policy is a table somebody can read,
 * every rule carries the reason it has that number, and a prune reports exactly
 * what it removed.
 *
 * The pruner refuses outright to delete a table it was not given a policy for.
 * A missing policy is the most dangerous state this code can be in: a loop
 * over "the tables we know about" that grows a new table into scope the moment
 * somebody adds one to the list would delete data nobody had decided to lose.
 */

export const RetentionPolicySchema = z
    .object({
        table: z.string().min(1),
        keepDays: z.coerce.number().int().positive(),
        rationale: z.string().min(1),
        /**
         * The column the cutoff is read from.
         *
         * Named rather than assumed, because the tables do not agree: history
         * is bucketed by hour and outcomes carry both an entry time and a
         * creation time, and a cutoff applied to the wrong one deletes either
         * too much or nothing.
         */
        timeColumn: z.string().min(1),
        /**
         * Tables that must not be pruned regardless of the row above.
         *
         * Kept as a list rather than as a comment in the seed data, because a
         * comment is not checked by anything.
         */
        protected: z.coerce.boolean(),
    })
    .refine((policy) => policy.keepDays >= 1, {
        message: 'A policy that keeps nothing is not a policy, it is a typo',
        path: ['keepDays'],
    });

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/**
 * The rules this build ships.
 *
 * Two are protected outright. `market_candles` is the series every
 * measurement is computed against: deleting old bars does not tidy anything,
 * it makes every historical figure unreproducible, because the code that
 * produced them will still be here and the data will not. `signal_outcome` is
 * the record of which signals were right — the one table whose loss is
 * directly a loss of knowledge rather than of detail.
 */
export const DEFAULT_RETENTION_POLICIES: readonly RetentionPolicy[] =
    z.array(RetentionPolicySchema).parse([
        {
            table: 'market_candles',
            keepDays: 3650,
            rationale:
                'Сигналы измеряются относительно баров. Удаление старых баров делает непроверяемым каждый исторический расчёт: код останется, данных не будет.',
            timeColumn: 'timestamp',
            protected: true,
        },
        {
            table: 'signal_outcome',
            keepDays: 3650,
            rationale:
                'Единственная таблица, где записано, какие сигналы оказались верными. Её потеря — это не потеря деталей, а потеря знания.',
            timeColumn: 'entry_timestamp',
            protected: true,
        },
        {
            table: 'signal_history',
            keepDays: 1095,
            rationale:
                'Три года покрывают несколько полных циклов и достаточно для калибровки. Дальше хвост почти не влияет на оценку, но стоит места.',
            timeColumn: 'hour_bucket',
            protected: false,
        },
        {
            table: 'signal_transition',
            keepDays: 1095,
            rationale:
                'Журнал переходов нужен, чтобы объяснить, почему сигнал закрылся. Стареет вместе с историей.',
            timeColumn: 'at',
            protected: false,
        },
        {
            table: 'indicator_vote',
            keepDays: 1095,
            rationale:
                'Голоса индикаторов объясняют сигнал; без них калибровка по вкладу не восстанавливается.',
            timeColumn: 'timestamp',
            protected: false,
        },
    ]);

export interface PrunePlan {
    readonly table: string;
    readonly cutoff: number;
    readonly keepDays: number;
    readonly reason: string;
    readonly protected: boolean;
}

/**
 * The cutoff for a rule at a given moment.
 *
 * Strictly older than the cutoff, so a bar exactly on the boundary survives.
 * A prune that removed it would be removing the most recent bar of a day whose
 * candles are still being written, and the next write would put it back —
 * making the prune look like it had worked and had deleted nothing.
 */
export function cutoffFor(policy: RetentionPolicy, now: number): number {
    return now - policy.keepDays * 86_400_000;
}

export interface Plan {
    readonly applicable: readonly PrunePlan[];
    readonly refused: readonly { table: string; reason: string }[];
}

/**
 * What a prune would do, before it does it.
 *
 * Protected tables are not silently skipped: they appear in `refused` with a
 * reason, so a reader of the plan can see that the data they expected to be
 * cleaned is still there on purpose.
 */
export function planPrune(
    policies: readonly RetentionPolicy[],
    now: number,
): Plan {
    const applicable: PrunePlan[] = [];
    const refused: { table: string; reason: string }[] = [];

    for (const policy of policies) {
        if (policy.protected) {
            refused.push({
                table: policy.table,
                reason: `защищена политикой: ${policy.rationale}`,
            });
            continue;
        }

        applicable.push({
            table: policy.table,
            cutoff: cutoffFor(policy, now),
            keepDays: policy.keepDays,
            reason: policy.rationale,
            protected: false,
        });
    }

    return { applicable, refused };
}

export interface UnknownTableReport {
    readonly known: boolean;
    readonly reason: string;
}

/**
 * Whether a table has a policy at all.
 *
 * A table with no policy is the dangerous state, and it is refused rather than
 * left to a default. The list of tables grows as the schema grows, and a
 * default of "prune at 90 days" applied to a table that arrived yesterday would
 * delete data nobody had decided to lose.
 */
export function describeTable(
    table: string,
    policies: readonly RetentionPolicy[] = DEFAULT_RETENTION_POLICIES,
): UnknownTableReport {
    const found = policies.find((policy) => policy.table === table);

    if (found === undefined) {
        return {
            known: false,
            reason:
                `у таблицы ${table} нет политики хранения. Без политики ничего не удаляется: лучше лишние строки, чем потерянные данные, о которых никто не решал.`,
        };
    }

    return {
        known: true,
        reason: found.protected
            ? `защищена: ${found.rationale}`
            : `хранится ${found.keepDays} дн.: ${found.rationale}`,
    };
}

export interface PruneResult {
    readonly table: string;
    readonly deleted: number;
    readonly cutoff: number;
    readonly durationMs: number;
    readonly skipped: number;
}

export interface PruneReport {
    readonly results: readonly PruneResult[];
    readonly refused: readonly { table: string; reason: string }[];
    readonly totalDeleted: number;
    readonly totalDurationMs: number;
    /**
     * True when nothing was deleted.
     *
     * Worth having as its own field, because a prune that deleted nothing and a
     * prune that never ran produce identical logs, and the difference is
     * whether the policy is being honoured.
     */
    readonly nothingToDo: boolean;
}

export function report(results: readonly PruneResult[], refused: Plan['refused']): PruneReport {
    return {
        results,
        refused,
        totalDeleted: results.reduce((sum, result) => sum + result.deleted, 0),
        totalDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
        nothingToDo: results.every((result) => result.deleted === 0),
    };
}
