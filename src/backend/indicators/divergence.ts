import type { DivergencePoint, DivergenceResult } from '../types/analysis.js';

/**
 * The divergence vocabulary and the shapes around a point, a pair and an
 * analysis, moved to `types/analysis.ts`.
 *
 * They were declared here, and `types/analysis.ts` imported them to build
 * `MarketAnalysis` — so the frozen contract reached up into `indicators/` for
 * three of its own fields. That is invariant 13, and it is closed by their being
 * here, with the contract, rather than here, with the code that happens to
 * compute them. `detectDivergence` below is the whole reason these shapes exist
 * and it stays where it is: a vocabulary belongs with the contract, a function
 * belongs with its arithmetic.
 *
 * The doc comments moved with the declarations, because they explain what the
 * values *are* and a comment left behind describes nothing. Re-exported so that
 * the two test files that read the vocabulary from here keep reading it from
 * here, and so that anyone arriving at this module finds the names it owns.
 */
export {
    DIVERGENCE_TYPES,
    type DivergenceAnalysis,
    type DivergencePoint,
    type DivergencePolarity,
    type DivergenceResult,
    type DivergenceType,
} from '../types/analysis.js';

export function detectDivergence(
    previous: DivergencePoint,
    current: DivergencePoint,
): DivergenceResult {
    if (
        current.price < previous.price &&
        current.momentum > previous.momentum
    ) {
        return {
            type: 'BULLISH',
            previous,
            current,
        };
    }

    if (
        current.price > previous.price &&
        current.momentum < previous.momentum
    ) {
        return {
            type: 'BEARISH',
            previous,
            current,
        };
    }

    return {
        type: 'NONE',
        previous,
        current,
    };
}
