import { consensusConfig } from '../config/consensus.config.js';
import type { assessDataQuality } from '../history/data-quality.js';
import type { RegimeContext, SignalExplanation } from '../signals/explanation.js';
import { explainSignal } from '../signals/explanation.js';
import type { MarketAnalysis } from '../types/analysis.js';

/**
 * The explanation that travels beside a published verdict.
 *
 * Split out of the analysis path so that assembling it — the one part of the
 * result that is prose rather than numbers — has one home. Pure: it reads the
 * analysis and the assessments that were measured for it and writes nothing
 * anywhere.
 */

/**
 * Builds the explanation from the analysis and the assessment measured beside it.
 *
 * The assessment is handed in rather than recomputed: the analysis path already
 * measured the market once, the explanation and the history row need the same
 * answer, and measuring the market twice for one answer would be the kind of
 * cost that looks free until two people copy it.
 */
export function buildExplanation(
    analysis: MarketAnalysis,
    market: {
        readonly regime: RegimeContext | null;
        readonly quality: ReturnType<typeof assessDataQuality> | null;
    },
): SignalExplanation {
    return explainSignal({
        direction: analysis.signal.signal,
        confidence: analysis.signal.confidence,
        confidenceModel: consensusConfig.confidenceModel,
        analyses: analysis.signal.indicators,
        // The published sentence, handed in rather than rebuilt. Explaining a
        // signal with a reason other than the one that was published is how a
        // system ends up defending two things at once, and the reason this
        // module sat unwired for its whole life is that nothing could check
        // that the two agreed.
        reason: analysis.signal.reason,
        // The assessment carries the factor with its score and a
        // sentence; the explanation wants the name on it. Reduced here,
        // deliberately, and the name still comes from the factor itself
        // rather than from a description of it -- which is how a summary
        // drifts away from the thing it summarises.
        quality:
            market.quality === null
                ? null
                : {
                      score: market.quality.score,
                      usable: market.quality.usable,
                      // `QualityFactor` is the name, not a record: the score
                      // and the sentence live in `factors`, and a summary
                      // that renamed them would describe something else.
                      worst: market.quality.worst,
                      blockedBy:
                          market.quality.blockedBy === null
                              ? []
                              : [market.quality.blockedBy],
                  },
        regime: market.regime,
    });
}
