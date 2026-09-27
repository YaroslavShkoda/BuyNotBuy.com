import { z } from 'zod';

import { RuleStageSchema, checkTransition, evaluateShadow, RuleEvidenceSchema, DEFAULT_PROMOTION_CONFIG } from './promotion.config.js';

import type { RuleStage, PromotionConfig, Verdict, RuleEvidence } from './promotion.config.js';

/**
 * A rule, and everything that happened to it.
 *
 * A rule that is only a predicate is not what this system changes. What it
 * changes is a *decision*, and a decision has to be able to be wrong in
 * production without anyone having to undo a deploy to stop it. So the record
 * holds the stage, the reason it is there, and the trail of how it got there
 * — and the trail is append-only, because a rule whose history can be edited
 * is a rule whose history cannot be trusted.
 *
 * The engine below is a pure state machine over that record. It has no clock,
 * no database and no I/O: the same transitions with the same evidence always
 * give the same answer, which is what makes the guardrails testable at all.
 */

const RuleSchema = z.object({
    id: z.string().min(1),
    stage: RuleStageSchema,
    /** Why this rule exists, in the author's words. */
    rationale: z.string().min(1),
    createdAt: z.coerce.number().int(),
    updatedAt: z.coerce.number().int(),
    /** What the rule actually is, as a serialisable value. */
    parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    /** Append-only. Every entry names what moved and what evidence it had. */
    history: z.array(
        z.object({
            at: z.coerce.number().int(),
            from: RuleStageSchema,
            to: RuleStageSchema,
            reason: z.string().min(1),
            evidence: RuleEvidenceSchema.optional(),
        }),
    ),
});

export type Rule = z.infer<typeof RuleSchema>;

export const RuleParser = RuleSchema;

export interface RuleInput {
    id: string;
    rationale: string;
    now: number;
    parameters: Rule['parameters'];
}

export function createRule(input: RuleInput): Rule {
    return RuleParser.parse({
        id: input.id,
        stage: 'candidate',
        rationale: input.rationale,
        createdAt: input.now,
        updatedAt: input.now,
        parameters: input.parameters,
        history: [],
    });
}

export interface EngineDecision {
    readonly applied: boolean;
    readonly rule: Rule;
    readonly verdict: Verdict | null;
    readonly reason: string;
}

/**
 * The rules that are allowed to affect anything.
 *
 * A single getter rather than a filter the caller remembers to apply. Every
 * path that reaches production goes through this one, because "did somebody
 * remember to filter by stage" is the question that decides whether the
 * guardrail is a guardrail.
 */
export function productionRules(rules: readonly Rule[]): Rule[] {
    return rules.filter((rule) => rule.stage === 'production');
}

export function activeRule(rules: readonly Rule[]): Rule | null {
    const live = productionRules(rules);

    // More than one production rule at a time is a decision the system made
    // without saying so. The registry reports it rather than picking one,
    // because picking one silently would make a promotion bug look like a
    // strategy change.
    return live[0] ?? null;
}

export interface ConflictReport {
    readonly conflict: boolean;
    readonly ids: readonly string[];
    readonly reason: string;
}

export function auditProduction(rules: readonly Rule[]): ConflictReport {
    const live = productionRules(rules);

    if (live.length > 1) {
        return {
            conflict: true,
            ids: live.map((rule) => rule.id),
            reason: `в продакшене ${live.length} правил одновременно: ${live
                .map((rule) => rule.id)
                .join(', ')}. Продвижение не должно оставлять второе, а если оставило — это надо разбирать, а не выбирать.`,
        };
    }

    return { conflict: false, ids: live.map((rule) => rule.id), reason: 'в продакшене не более одного правила' };
}

export function advance(
    rule: Rule,
    to: RuleStage,
    now: number,
    config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
    evidence?: RuleEvidence,
): EngineDecision {
    const transition = checkTransition(rule.stage, to);

    if (!transition.allowed) {
        // A refused move leaves the record untouched. A history entry for a
        // transition that did not happen would pad the trail with attempts
        // and hide the fact that the guardrail held.
        return { applied: false, rule, verdict: null, reason: transition.reason };
    }

    if (to === 'approved') {
        const verdict = evaluateShadow(
            evidence ?? {
                signals: 0,
                resolved: 0,
                correct: 0,
                incorrect: 0,
                flat: 0,
                incumbentCorrect: 0,
                incumbentResolved: 0,
                firstSeenAt: now,
                lastSeenAt: now,
            },
            config,
            now,
        );

        if (!verdict.ready) {
            return {
                applied: false,
                rule,
                verdict,
                reason: `не одобрено: ${verdict.reason}. ${
                    verdict.outstanding.join('; ')
                }`,
            };
        }

        return {
            applied: true,
            rule: record(rule, to, now, verdict.reason, evidence),
            verdict,
            reason: verdict.reason,
        };
    }

    const reason = to === 'rejected' || to === 'retired' ? 'снято с системы' : 'этап пройден';

    return {
        applied: true,
        rule: record(rule, to, now, reason, evidence),
        verdict: null,
        reason,
    };
}

function record(
    rule: Rule,
    to: RuleStage,
    now: number,
    reason: string,
    evidence?: RuleEvidence,
): Rule {
    return RuleParser.parse({
        ...rule,
        stage: to,
        updatedAt: now,
        history: [
            ...rule.history,
            {
                at: now,
                from: rule.stage,
                to,
                reason,
                // Present only when there was evidence, and its absence is
                // meaningful: a stage moved without evidence is a stage
                // somebody walked past.
                ...(evidence === undefined ? {} : { evidence }),
            },
        ],
    });
}

/**
 * Takes a rule out of production and puts back whatever was there before.
 *
 * The rollback target is found by walking the trail rather than by a stored
 * pointer, because a stored pointer goes stale the moment a rule is retired
 * and then reinstated, and a rollback that restores a rule nobody can name is
 * worse than no rollback.
 */
export interface RollbackPlan {
    readonly restored: Rule | null;
    readonly retired: Rule;
    readonly reason: string;
}

export function planRollback(
    rules: readonly Rule[],
    now: number,
    config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
): RollbackPlan | null {
    const live = rules.find((rule) => rule.stage === 'production');

    if (live === undefined) {
        return null;
    }

    // Found by walking each rule's own trail, not by filtering on its current
    // stage. A rule that was in production, got retired and then went back to
    // candidate is a candidate now, and a filter on the stage would miss it —
    // which is the same staleness a stored pointer suffers from, arrived at
    // from the other direction.
    // findLast by hand: the tsconfig lib predates it, and reaching for a
    // polyfill over a four-element array is not a trade worth making.
    const lastEntryTo = (entries: Rule['history'], to: RuleStage) => {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            if (entries[index]?.to === to) {
                return entries[index];
            }
        }

        return undefined;
    };

    const liveSince = lastEntryTo(live.history, 'production')?.at;

    const previous = rules
        .filter((rule) => rule.id !== live.id)
        .map((rule) => ({
            rule,
            enteredAt: lastEntryTo(rule.history, 'production')?.at,
        }))
        .filter(
            (entry): entry is { rule: Rule; enteredAt: number } =>
                entry.enteredAt !== undefined &&
                (liveSince === undefined || entry.enteredAt < liveSince),
        )
        .sort((a, b) => b.enteredAt - a.enteredAt);

    const top = previous[0];
    const tied = previous.filter((entry) => entry.enteredAt === top?.enteredAt);

    if (top !== undefined && tied.length > 1) {
        // Two rules that entered production in the same millisecond. The trail
        // is a total order inside one rule and has no order between two, so
        // there is nothing here to decide on. Guessing would produce a
        // rollback that looks like it worked and restores somebody else's rule.
        return {
            restored: null,
            retired: record(
                live,
                'retired',
                now,
                'откат не выполнен: предыдущее правило не определено',
            ),
            reason:
                `предыдущее правило не определено: ${tied.length} правила ` +
                `(${tied.map((entry) => entry.rule.id).join(', ')}) вступили в ` +
                `продакшен в один момент ${top.enteredAt}. Разбираться в этом надо вручную.`,
        };
    }

    const retired = record(
        live,
        'retired',
        now,
        'откат: действующее правило снято по запросу',
    );

    if (top === undefined) {
        return {
            restored: null,
            retired,
            // Explicit that there is nothing to go back to. A rollback that
            // silently leaves the system with no rule would report itself as
            // a success.
            reason:
                'предыдущего правила в системе нет: после отката сигналы не будут генерироваться вовсе, и это надо сказать вслух',
        };
    }

    const restored = advance(top.rule, 'candidate', now, config);

    return {
        restored: restored.rule,
        retired,
        reason: `откат на ${top.rule.id}, который был в продакшене до ${live.id}`,
    };
}
