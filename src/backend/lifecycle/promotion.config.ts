import { z } from 'zod';

import { outcomeConfig } from '../config/outcome.config.js';

/**
 * The rules a candidate has to pass to become what the system actually does.
 *
 * The order of these is the whole design. Nothing skips to production: a rule
 * has to earn its way through shadow, through a comparison, through a human
 * approval, and only then does anything change for a real user. The reason is
 * not caution for its own sake. Every step down this list is a step where a
 * thing that looks right on paper gets caught by something that is not paper,
 * and the earlier the catch the cheaper it is — a rule rejected in shadow cost
 * one simulation, the same rule rejected in production cost its users a month.
 *
 * A candidate that cannot state why it should exist is not refused because it
 * is unproven, but because a change nobody can explain is a change nobody can
 * be accountable for once it starts losing money.
 */

const PromotionConfigSchema = z
    .object({
        /** How long a rule must sit in shadow before it can be considered. */
        shadowMinimumMs: z.coerce.number().int().positive(),
        /** How many resolved signals a rule needs before its shadow is a sample. */
        shadowMinimumSignals: z.coerce.number().int().positive(),
        /** How long shadow and production evidence are kept. */
        shadowRetentionMs: z.coerce.number().int().positive(),
        /**
         * How much worse than the incumbent a candidate may be and still be
         * promoted.
         *
         * Negative, because this is a *deficit*: a candidate that beats the
         * incumbent by a margin is not a coincidence, it is the point. A
         * positive value would mean "promote anything within X of the best",
         * which promotes the incumbent into itself.
         */
        promotionMargin: z.coerce.number().lt(0),
        /** Smallest sample that may be judged at all. */
        minimumSample: z.coerce.number().int().positive(),
        /**
         * How often the shadow can see a signal.
         *
         * A shadow gets at most one signal per bar, so the window it is given
         * bounds how much evidence it can possibly collect. Without this the
         * configuration could ask for 200 signals inside a 1000ms window, and
         * the rule would sit in shadow forever waiting for evidence the market
         * physically cannot produce — a rule blocked by arithmetic rather
         * than by evidence, which is the most demoralising possible reason to
         * wait.
         */
        barIntervalMs: z.coerce.number().int().positive(),
        /**
         * The distance at which a signal is judged correct or incorrect.
         *
         * Every signal is measured at several horizons, and those measurements
         * are **not independent samples of the same thing** — they are one
         * signal read at different distances. Counting them as seven votes
         * would let a rule clear a twenty-sample gate on three signals, and it
         * would do so silently, because every row is a real row and every count
         * is a true count. The arithmetic is only wrong.
         *
         * So the gate counts one vote per signal, at this horizon, and the
         * horizon is named rather than left inside a WHERE clause nobody reads.
         * It defaults to the shortest configured horizon because that is the
         * system's own definition of "how long a signal has to work", and
         * because judging at every distance at once would make the result
         * depend on which one happened to come out best.
         */
        evaluationHorizonBars: z
            .coerce
            .number()
            .int()
            .positive()
            // Defaulted rather than required, and the two are not the same
            // choice. Required would mean every deployment has to name it and
            // every test literal has to carry a field that says nothing about
            // the test. Defaulted, the value is still always present after
            // parsing, so nothing downstream has to guard against its absence.
            //
            // It comes from the outcome system rather than being written here,
            // because two places that both name the horizon are two places
            // that will disagree.
            .default(outcomeConfig.horizons[0] ?? 6),
    })
    .refine(
        (config) =>
            config.shadowMinimumSignals * config.barIntervalMs <=
            config.shadowMinimumMs,
        {
            message:
                'The shadow window is too short to collect the signals it is required to collect',
            path: ['shadowMinimumMs'],
        },
    );

type PromotionConfig = z.infer<typeof PromotionConfigSchema>;

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig =
    PromotionConfigSchema.parse({
        // 90 days at the daily interval the market is configured for, and 60
        // signals. The first number I wrote was 200, which this same check
        // rejected on the first run: 200 daily bars is 200 days, and a rule
        // would have been waiting forever for evidence the interval cannot
        // produce. The rule fires on some bars rather than all of them, so 60
        // is generous rather than optimistic.
        shadowMinimumMs: 90 * 24 * 3_600_000,
        barIntervalMs: 24 * 3_600_000,
        shadowMinimumSignals: 60,
        shadowRetentionMs: 365 * 24 * 3_600_000,
        promotionMargin: -0.02,
        minimumSample: 20,
    });

/**
 * Removed: `canTransition` — the RuleStage ladder it read (`RuleStageSchema`,
 * `RuleStage`, `FORWARD`) reached no storage. The CHECK migration 17 puts on
 * `signal_strategy_version.stage` admits `CANDIDATE_STAGES` and none of this
 * vocabulary, and the engine that moved rules along it
 * (`lifecycle/rule-registry.ts`) was deleted in round 84; the words it moved
 * between stayed behind with zero production callers, held in place only by
 * `lifecycle/stage-vocabulary.test.ts`, whose whole subject was the
 * disagreement. The ladder the database actually stores is `CandidateStage`
 * in `strategies/candidate.repository.ts`, where `retired` is terminal.
 * Whether a retired rule may run again is the owner's open question
 * (docs/open-questions.md); a yes is a migration on the stage column and a
 * policy module of its own — not this vocabulary back.
 *
 * Removed: `checkTransition` — the explanatory wrapper over `canTransition`,
 * whose doc comment carried the two-ladder disagreement the removal settles.
 */

const RuleEvidenceSchema = z.object({
    /** Signals the rule actually produced, resolved or not. */
    signals: z.coerce.number().int().nonnegative(),
    /** Resolved ones — an unresolved signal is a question, not an answer. */
    resolved: z.coerce.number().int().nonnegative(),
    correct: z.coerce.number().int().nonnegative(),
    incorrect: z.coerce.number().int().nonnegative(),
    flat: z.coerce.number().int().nonnegative(),
    /** What the current production rule did over the same window. */
    incumbentCorrect: z.coerce.number().int().nonnegative(),
    incumbentResolved: z.coerce.number().int().nonnegative(),
    firstSeenAt: z.coerce.number().int(),
    lastSeenAt: z.coerce.number().int(),
});

export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

export interface Verdict {
    readonly ready: boolean;
    readonly reason: string;
    /** What is still missing, in words. */
    readonly outstanding: readonly string[];
}

function accuracy(correct: number, resolved: number): number | null {
    return resolved === 0 ? null : correct / resolved;
}

/**
 * Decides whether a shadowed rule is ready to be considered.
 *
 * Three separate conditions, each reported separately, because "not ready" is
 * not an answer a reader can act on — "it has 40 signals, it needs 200" and
 * "it has 200 signals and got 51% of them, the incumbent got 62%" call for
 * completely different reactions. The second one is a reason to stop and the
 * first is a reason to wait, and a system that reports them as the same
 * verdict has thrown away the distinction.
 */
export function evaluateShadow(
    evidence: RuleEvidence,
    config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
    now: number,
): Verdict {
    const outstanding: string[] = [];

    if (evidence.signals < config.shadowMinimumSignals) {
        outstanding.push(
            `сигналов ${evidence.signals}, нужно ${config.shadowMinimumSignals}`,
        );
    }

    const age = now - evidence.firstSeenAt;

    if (age < config.shadowMinimumMs) {
        outstanding.push(
            `прошло ${Math.floor(age / 86_400_000)} дн., нужно ${Math.floor(
                config.shadowMinimumMs / 86_400_000,
            )}`,
        );
    }

    if (evidence.resolved < config.minimumSample) {
        outstanding.push(
            `разрешено ${evidence.resolved}, нужно минимум ${config.minimumSample}`,
        );
    }

    if (outstanding.length > 0) {
        return {
            ready: false,
            reason: 'наблюдения пока недостаточно, чтобы судить',
            outstanding,
        };
    }

    const candidate = accuracy(evidence.correct, evidence.resolved) ?? 0;
    const incumbent = accuracy(
        evidence.incumbentCorrect,
        evidence.incumbentResolved,
    );

    if (incumbent === null) {
        // No incumbent evidence is not a free pass. A rule promoted against
        // nothing is a rule whose comparison was never made, and the promotion
        // record would say it beat the incumbent.
        return {
            ready: false,
            reason: 'не с чем сравнивать: у действующего правила нет разрешённых сигналов за это же окно',
            outstanding: [
                'нужна история действующего правила по тому же окну',
            ],
        };
    }

    if (candidate < incumbent + config.promotionMargin) {
        return {
            ready: false,
            reason:
                `точность ${(candidate * 100).toFixed(1)}% против ` +
                `${(incumbent * 100).toFixed(1)}% у действующего — ` +
                `не хватает ${(Math.abs(config.promotionMargin) * 100).toFixed(1)} п.п.`,
            outstanding: ['кандидат не выигрывает с запасом'],
        };
    }

    return {
        ready: true,
        reason:
            `точность ${(candidate * 100).toFixed(1)}% против ` +
            `${(incumbent * 100).toFixed(1)}% у действующего на ` +
            `${evidence.resolved} разрешённых сигналах`,
        outstanding: [],
    };
}
