import { createEvidenceReader } from '../strategy/evidence.repository.js';
import { DEFAULT_PROMOTION_CONFIG, evaluateShadow } from '../strategy/promotion.config.js';
import { getStrategyVersionRepository } from '../analysis/strategy-version.repository.js';
import { marketConfig } from '../config/market.config.js';

import type { PromotionGate } from '../strategies/candidate.repository.js';

/**
 * The evidence gate, wired to the ladder.
 *
 * **This is the file that makes `evaluateShadow` reachable.** It existed, with
 * a complete set of conditions and no callers, for as long as the ladder
 * existed. It could not be called from `candidate.repository` because that
 * module is not allowed to import the layer the evidence lives in — and that
 * restriction is correct: a repository that writes rows should not decide what
 * those rows have to mean. The composition root is where a question gets
 * connected to the thing that can answer it.
 */
export function createEvidenceGate(
    now: () => number = Date.now,
): PromotionGate {
    const reader = createEvidenceReader();

    return {
        async check({ ruleId, to, strategyVersionId }) {
            // Only approval ends a shadow. Every other stage change is about
            // where the rule is going and needs no history yet, and asking the
            // question on the first promotion would refuse every new rule on
            // the grounds that it has never run, which is true and useless.
            if (to !== 'approval') {
                return;
            }

            if (strategyVersionId === null) {
                throw new Error(
                    `"${ruleId}" cannot be approved without saying which ` +
                        'configuration produced its shadow evidence. A promotion ' +
                        'nobody can re-derive later is exactly what this ladder ' +
                        'exists to prevent.',
                );
            }

            // The incumbent is the configuration currently running, and the gate
            // is not told which market it is judging — `PromotionGate.check`
            // carries a rule, a stage and a version, and nothing else. So this
            // asks for the shipped configuration rather than guessing a market:
            // a gate that silently picked one of several running markets would
            // compare a candidate against whichever configuration happened to be
            // named first.
            //
            // That the question is unanswered is recorded as an open decision
            // rather than left implied. The moment the gate carries a market, this
            // becomes `resolveActive(instrument)` and the comparison is per market,
            // which is the only form of it that means anything once two markets
            // run different thresholds.
            const incumbent = await getStrategyVersionRepository().resolveActive(
                marketConfig.symbol,
            );
            const evidence = await reader.evidenceFor(
                strategyVersionId,
                DEFAULT_PROMOTION_CONFIG.evaluationHorizonBars,
                incumbent === null ? null : incumbent.id,
            );
            const verdict = evaluateShadow(evidence, DEFAULT_PROMOTION_CONFIG, now());

            if (!verdict.ready) {
                throw new Error(
                    `"${ruleId}" is not ready for approval: ${verdict.reason}. ` +
                        `Не хватает: ${verdict.outstanding.join('; ')}`,
                );
            }
        },
    };
}
