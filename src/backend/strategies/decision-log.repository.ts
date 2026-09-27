import { query } from '../db/pool.js';

import type { StrategyKey } from './types.js';

/**
 * What every strategy said on one analysis cycle, and which of them was heard.
 *
 * The point of writing this down is the promotion decision, and that decision
 * cannot be made from a number that was never stored. The fallback has been
 * evaluated on every cycle since it was added and its answer was dropped on the
 * floor each time, so there is currently no evidence at all about whether it
 * agrees with the primary, which is the only question worth asking before
 * letting it publish.
 *
 * Both answers are stored. Recording only the published one would make the
 * disagreements — the only informative rows — unreconstructable, and would
 * leave a table whose contents were already decided by the time it was written.
 */

export interface DecisionEntry {
    readonly symbol: string;
    readonly strategyVersionId: number | null;
    readonly primary: {
        readonly rule: StrategyKey;
        readonly direction: 'LONG' | 'SHORT' | 'NEUTRAL';
        readonly confidence: number;
    };
    readonly fallback: {
        readonly rule: StrategyKey;
        readonly direction: 'LONG' | 'SHORT' | 'NEUTRAL';
        readonly confidence: number;
    } | null;
    readonly publishedRule: StrategyKey;
    readonly publishedDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
    readonly suppressed: boolean;
    readonly at: number;
}

export interface DecisionLogRepository {
    record(entry: DecisionEntry): Promise<void>;
    /** Everything the shadow period has collected, in one number. */
    shadowReport(since: number): Promise<ShadowReport>;
}

/**
 * What a shadow period has actually produced.
 *
 * `agreement` is the number to read first, and it is deliberately the rate of
 * agreement rather than a performance figure. A fallback that agrees with the
 * primary always has learned nothing, and one that disagrees always has learned
 * everything — neither is a candidate for promotion on its own, and reporting
 * only the disagreement count would make the quiet case look uninteresting
 * rather than empty.
 */
export interface ShadowReport {
    readonly cycles: number;
    readonly suppressed: number;
    readonly agreement: number;
    readonly byDirection: Readonly<
        Record<'LONG' | 'SHORT' | 'NEUTRAL', number>
    >;
    readonly breakdown: readonly {
        readonly rule: StrategyKey;
        readonly cycles: number;
        readonly suppressed: number;
        readonly agreement: number;
    }[];
}

export function createDecisionLogRepository(): DecisionLogRepository {
    return {
        async record(entry: DecisionEntry): Promise<void> {
            await query(
                `INSERT INTO strategy_decision_log
                     (created_at, symbol, strategy_version_id,
                      primary_rule, primary_direction, primary_confidence,
                      fallback_rule, fallback_direction, fallback_confidence,
                      published_rule, published_direction, suppressed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    entry.at,
                    entry.symbol,
                    entry.strategyVersionId,
                    entry.primary.rule,
                    entry.primary.direction,
                    entry.primary.confidence,
                    entry.fallback?.rule ?? null,
                    entry.fallback?.direction ?? null,
                    entry.fallback?.confidence ?? null,
                    entry.publishedRule,
                    entry.publishedDirection,
                    entry.suppressed,
                ],
            );
        },

        async shadowReport(since: number): Promise<ShadowReport> {
            const { rows } = await query<{
                fallback_rule: StrategyKey | null;
                cycles: string;
                suppressed: string;
                agreed: string;
            }>(
                `SELECT fallback_rule,
                        COUNT(*)                                       AS cycles,
                        COUNT(*) FILTER (WHERE suppressed)             AS suppressed,
                        COUNT(*) FILTER (WHERE NOT suppressed
                                         AND fallback_direction = published_direction)
                                                                 AS agreed
                   FROM strategy_decision_log
                  WHERE created_at >= $1
                    AND fallback_direction IS NOT NULL
                  GROUP BY fallback_rule
                  ORDER BY fallback_rule`,
                [since],
            );

            const breakdown = rows.map((row) => {
                const cycles = Number(row.cycles);

                return {
                    rule: row.fallback_rule as StrategyKey,
                    cycles,
                    suppressed: Number(row.suppressed),
                    agreement:
                        cycles - Number(row.suppressed) === 0
                            ? 0
                            : Number(row.agreed) /
                              (cycles - Number(row.suppressed)),
                };
            });

            const cycles = breakdown.reduce((sum, row) => sum + row.cycles, 0);
            const suppressed = breakdown.reduce(
                (sum, row) => sum + row.suppressed,
                0,
            );
            const publishable = cycles - suppressed;

            const byDirection = await query<{
                fallback_direction: 'LONG' | 'SHORT' | 'NEUTRAL';
                count: string;
            }>(
                `SELECT fallback_direction, COUNT(*) AS count
                   FROM strategy_decision_log
                  WHERE created_at >= $1
                    AND fallback_direction IS NOT NULL
                  GROUP BY fallback_direction`,
                [since],
            );

            const counts: Record<'LONG' | 'SHORT' | 'NEUTRAL', number> = {
                LONG: 0,
                SHORT: 0,
                NEUTRAL: 0,
            };

            for (const row of byDirection.rows) {
                counts[row.fallback_direction] = Number(row.count);
            }

            return {
                cycles,
                suppressed,
                agreement:
                    publishable === 0
                        ? 0
                        : breakdown.reduce((sum, row) => sum + row.agreement * (row.cycles - row.suppressed), 0) /
                          publishable,
                byDirection: counts,
                breakdown,
            };
        },
    };
}

let shared: DecisionLogRepository | null = null;

export function getDecisionLogRepository(): DecisionLogRepository {
    shared ??= createDecisionLogRepository();

    return shared;
}

/** Test seam: the singleton exists so production shares one, not so tests share rows. */
export function resetDecisionLogRepository(): void {
    shared = null;
}
