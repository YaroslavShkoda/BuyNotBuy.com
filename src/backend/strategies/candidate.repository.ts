import { query } from '../db/pool.js';

/**
 * Which stage a rule has reached, and who moved it.
 *
 * The pipeline in this project says a candidate goes candidate, then
 * backtest, then walk-forward, then shadow, then approval, then production. It
 * has been a paragraph in a design document and a mental convention, and the
 * consequence was that "promoting a rule" was an environment variable. Setting
 * `FALLBACK_MODE=active` made a rule authoritative with no record of who decided
 * that, when, or on what evidence — and no way to answer afterwards whether a
 * number had come from a rule that had been running for a month or one that had
 * been switched on yesterday.
 *
 * `signal_strategy_version` was created by migration 12 for precisely this and
 * has never been read or written by a line of application code. It is the
 * table this needs, so this uses it.
 *
 * Two rules the type enforces:
 *
 * Stages move **forward only**. A rule that has been approved does not become a
 * candidate again because someone had a bad week; it is retired, which is a
 * different state with a date on it.
 *
 * A promotion must **say what it is based on**. `evidence` is not optional,
 * because "promote donchian-20 because the backtest looked good" is exactly the
 * sentence this whole apparatus exists to make hard to write.
 */

export const CANDIDATE_STAGES = [
    'candidate',
    'backtest',
    'walk-forward',
    'shadow',
    'approval',
    'production',
    'retired',
] as const;

export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export interface StrategyRuleRecord {
    readonly id: number;
    readonly ruleId: string;
    readonly stage: CandidateStage;
    readonly parameters: Record<string, unknown>;
    readonly evidence: string;
    readonly promotedAt: number;
    readonly retiredAt: number | null;
    readonly createdAt: number;
    /**
     * The configuration this promotion happened under, or null when nobody said.
     *
     * Null is not a gap to be filled by inference. The rule's own parameters and
     * the indicator configuration live in different spaces, so there is nothing
     * to compute this from — a rule whose parameters are `{channelPeriod: 20}`
     * has no representation in `strategy_version.config` at all. The evidence
     * gate has to refuse on a null rather than guess at one.
     */
    readonly strategyVersionId: number | null;
}

/**
 * Where a stage is allowed to go next.
 *
 * 'retired' is reachable from anywhere and goes nowhere: a retired rule is not
 * a candidate again, it is history. The rest are a chain, so a rule cannot skip
 * the shadow period on the way to production no matter who asks.
 */
const NEXT_STAGE: Readonly<Record<CandidateStage, readonly CandidateStage[]>> = {
    candidate: ['backtest', 'retired'],
    backtest: ['walk-forward', 'retired'],
    'walk-forward': ['shadow', 'retired'],
    shadow: ['approval', 'retired'],
    approval: ['production', 'retired'],
    production: ['retired'],
    retired: [],
};

export function canTransition(from: CandidateStage, to: CandidateStage): boolean {
    return NEXT_STAGE[from].includes(to);
}

/**
 * The one question a promotion has to answer before it is allowed.
 *
 * **Declared here and implemented elsewhere, because the answer lives in a
 * layer this one may not import.** The evidence gate reads measurements, and
 * measurements live in the strategy layer, which `strategies` is not allowed to
 * depend on. Declaring the question as an interface keeps the ordering of
 * imports honest: this module knows that approval requires evidence and never
 * learns what evidence is.
 */
export interface PromotionGate {
    /**
     * @throws when the rule has not earned the stage it is asking for. The
     *   message is the reason a reader needs, not a status code.
     */
    check(input: GateCheck): Promise<void>;
}

export interface GateCheck {
    readonly ruleId: string;
    readonly to: CandidateStage;
    readonly strategyVersionId: number | null;
}

export interface StrategyRuleRepository {
    /** Every stage change a rule has ever been through, oldest first. */
    history(ruleId: string): Promise<readonly StrategyRuleRecord[]>;
    current(ruleId: string): Promise<StrategyRuleRecord | null>;
    promote(input: Promotion): Promise<StrategyRuleRecord>;
}

export interface Promotion {
    readonly ruleId: string;
    readonly to: CandidateStage;
    readonly parameters: Record<string, unknown>;
    /** What the decision rests on. Required, and may not be empty. */
    readonly evidence: string;
    /**
     * The strategy version in force when this promotion was decided.
     *
     * Optional only because a promotion may predate the column that records it;
     * it is **not** optional because a promotion can happen without a caller
     * that knows, and writing null there would produce a row that looks
     * complete and can never be joined to a measurement.
     */
    readonly strategyVersionId?: number | null;
    readonly at?: number;
}

export function createStrategyRuleRepository(gate?: PromotionGate): StrategyRuleRepository {
    const columns =
        'id, rule_id, stage, parameters, promoted_at, retired_at, created_at, strategy_version_id';

    return {
        async history(ruleId: string): Promise<readonly StrategyRuleRecord[]> {
            const { rows } = await query<Record<string, unknown>>(
                // `${columns}`, not a list spelled out again. A promotion that
                // names its configuration came back attributed from `promote`
                // and unattributed from `history`, because this line had its
                // own copy of the column list and was one column behind. The
                // failure was silent in both directions: the row was written
                // correctly and read back as "unknown".
                `SELECT ${columns}
                   FROM signal_strategy_version
                  WHERE rule_id = $1
                  ORDER BY promoted_at, id`,
                [ruleId],
            );

            return rows.map(toRecord);
        },

        async current(ruleId: string): Promise<StrategyRuleRecord | null> {
            const { rows } = await query<Record<string, unknown>>(
                `SELECT ${columns} FROM signal_strategy_version
                  WHERE rule_id = $1
                  ORDER BY promoted_at DESC, id DESC
                  LIMIT 1`,
                [ruleId],
            );

            return rows[0] === undefined ? null : toRecord(rows[0]);
        },

        async promote(input: Promotion): Promise<StrategyRuleRecord> {
            if (input.evidence.trim().length === 0) {
                // A promotion with nothing behind it is the failure this table
                // was built to prevent, and it is exactly one careless call
                // away.
                throw new Error(
                    `Cannot promote "${input.ruleId}" to ${input.to} without ` +
                        'saying what the decision rests on. Продвижение без ' +
                        'основания — ровно то, чего эта таблица не должна ' +
                        'позволить.',
                );
            }

            const existing = await this.current(input.ruleId);

            // **The gate, and what it is asked about.**
            //
            // It runs before anything is written and it is asked about the stage
            // being entered, not the one being left. Approval is where a shadow
            // ends, so that is where the evidence has to exist.
            //
            // It is passed the configuration the promotion claims, not the one
            // that happens to be active. When the two differ — and they differ
            // exactly when the fallback is running — grading the candidate on the
            // incumbent's numbers would measure the wrong rule, and a gate that
            // passes on someone else's evidence is not a gate.
            //
            // A null version is refused rather than skipped. Without it there is
            // nothing to measure, and a promotion nobody can check later is the
            // exact thing this table was built to prevent.
            if (gate !== undefined) {
                await gate.check({
                    ruleId: input.ruleId,
                    to: input.to,
                    strategyVersionId: input.strategyVersionId ?? null,
                });
            }

            if (existing === null) {
                // A rule that has never been recorded can only be recorded as
                // what it is: a candidate. Without this, the transition check
                // below is skipped entirely for the one promotion that matters
                // most — the first — and a new rule can be inserted straight
                // into production.
                if (input.to !== 'candidate') {
                    throw new Error(
                        `"${input.ruleId}" is not registered, so it starts as a ` +
                            `candidate and cannot be created directly as ${input.to}.`,
                    );
                }
            } else {
                if (!canTransition(existing.stage, input.to)) {
                    throw new Error(
                        `Cannot move "${input.ruleId}" from ${existing.stage} to ` +
                            `${input.to}. Stages move forward only, and a rule ` +
                            `that has been retired is not a candidate again.`,
                    );
                }

                if (input.to === 'retired') {
                    // The stage as well as the date. Stamping `retired_at` and
                    // leaving `stage` alone looks like retirement while the
                    // rule is still perfectly promotable from whatever it was
                    // before — a rule retired from candidate could be moved
                    // straight to backtest afterwards, which is not a
                    // retirement.
                    const { rows } = await query<Record<string, unknown>>(
                        `UPDATE signal_strategy_version
                            SET stage = 'retired', retired_at = $3
                          WHERE id = $1 AND rule_id = $2
                          RETURNING ${columns}`,
                        [existing.id, input.ruleId, input.at ?? Date.now()],
                    );

                    return toRecord(rows[0]!);
                }
            }

            // A new row per stage rather than an update in place. The point of
            // the table is the history: an audit that keeps only the current
            // state is a state, not a record, and a rule that reached approval
            // and then production should show both.
            const { rows } = await query<Record<string, unknown>>(
                `INSERT INTO signal_strategy_version
                     (rule_id, stage, parameters, promoted_at, retired_at, created_at,
                      strategy_version_id)
                 VALUES ($1, $2, $3::jsonb, $4, NULL, $4, $5)
                 RETURNING ${columns}`,
                [
                    input.ruleId,
                    input.to,
                    // The evidence is stored inside the parameters blob because
                    // migration twelve did not give the table a column for it,
                    // and checked into the row rather than merely required at
                    // the call site. An argument that is validated and then
                    // dropped is a validation that buys nothing: the row would
                    // still be unable to say why the rule moved.
                    JSON.stringify({
                        ...input.parameters,
                        evidence: input.evidence,
                    }),
                    input.at ?? Date.now(),
                    input.strategyVersionId ?? null,
                ],
            );

            return toRecord(rows[0]!);
        },
    };
}

function toRecord(row: Record<string, unknown>): StrategyRuleRecord {
    return {
        id: Number(row['id']),
        ruleId: String(row['rule_id']),
        stage: row['stage'] as CandidateStage,
        parameters: (row['parameters'] ?? {}) as Record<string, unknown>,
        // Not a column: the migration predates this repository and the table
        // has no place for it. Carried as the parameters' own key so that a
        // promotion still has to say why without a migration to add the column.
        evidence: String(
            (row['parameters'] as Record<string, unknown> | null)?.['evidence'] ??
                '',
        ),
        promotedAt: Number(row['promoted_at']),
        retiredAt:
            row['retired_at'] === null || row['retired_at'] === undefined
                ? null
                : Number(row['retired_at']),
        createdAt: Number(row['created_at']),
        strategyVersionId:
            row['strategy_version_id'] === null || row['strategy_version_id'] === undefined
                ? null
                : Number(row['strategy_version_id']),
    };
}

let shared: StrategyRuleRepository | null = null;

/**
 * The repository every entry point gets.
 *
 * A gate handed here is remembered, and **the first call decides**. A later
 * call that quietly replaced it with an ungated one would reopen the hole this
 * was closed to fix, so a second, different gate is refused rather than
 * preferred.
 */
export function getStrategyRuleRepository(gate?: PromotionGate): StrategyRuleRepository {
    if (gate !== undefined) {
        if (shared !== null && !gated) {
            throw new Error(
                'The strategy rule repository was already taken without an ' +
                    'evidence gate, and a gate cannot be attached after the fact.',
            );
        }

        gated = true;
    }

    shared ??= createStrategyRuleRepository(gate);

    return shared;
}

let gated = false;
