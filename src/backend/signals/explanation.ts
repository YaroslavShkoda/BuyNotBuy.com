import type { ConfidenceModel } from '../config/consensus.config.js';
import { describeSignal, partitionPanel } from './consensus.js';
import type { IndicatorAnalysis, IndicatorSignal } from './signal.types.js';

/**
 * Why this signal was published, in a form that can be argued with.
 *
 * A verdict and a sentence are not the same thing. "LONG, 71%, three indicators
 * agree" is a claim with no evidence attached, and the only way to check it is
 * to go and read the code that produced it. This is that evidence: which
 * indicators voted which way, what the market looked like while they did, and
 * how much of the published number is the panel and how much is the market's
 * own condition.
 *
 * The structure exists because the reasons are the part that has to survive a
 * reader. The `reason` string at the edge is still there and is still in
 * Russian, because the dashboard shows it and the frontend is not ours to
 * break — but it is now generated from this rather than assembled alongside
 * it, which is what makes the two incapable of disagreeing.
 */

/**
 * One thing that moved the number, and in which direction.
 *
 * `weight` is that thing's share of the total, not its own conviction. A
 * factor that moved the number by three percent is worth three percent, however
 * sure the indicator was, because the question is what explained the result
 * rather than what the panel believed.
 */
interface ConfidenceFactor {
    readonly key: string;
    /** Shown to a person. */
    readonly label: string;
    /** How much this pushed the number, in percentage points. */
    readonly impact: number;
    /**
     * Whether this helped or hurt.
     *
     * Kept separate from the sign of `impact` because a factor can help by
     * being present and hurt by being absent, and both directions are
     * information: "RSI agreed" and "RSI was too low to comment" are different
     * facts about the same market.
     */
    readonly stance: 'supporting' | 'opposing' | 'neutral';
    /** What the value was, for anyone checking the arithmetic. */
    readonly detail: string;
}

export interface RegimeContext {
    readonly volatility: string;
    readonly trend: string;
    /**
     * Why the regime may not be trusted, when it may not be.
     *
     * Carried through rather than dropped, so a regime label computed from
     * forty bars does not read the same as one computed from eight hundred.
     */
    readonly unreliable: string | null;
}

interface QualityContext {
    readonly score: number;
    readonly usable: boolean;
    /** The factor that dragged the score down, when one did. */
    readonly worst: string | null;
    readonly blockedBy: readonly string[];
}

export interface SignalExplanation {
    readonly direction: IndicatorSignal;
    /** The indicators that voted with the published direction. */
    readonly supporting: readonly IndicatorAnalysis[];
    /** The ones that voted against it. */
    readonly opposing: readonly IndicatorAnalysis[];
    /** The ones that had no opinion. */
    readonly abstaining: readonly IndicatorAnalysis[];
    readonly regime: RegimeContext | null;
    readonly quality: QualityContext | null;
    /**
     * What moved the published number, largest first.
     *
     * Empty when nothing was published, and that is itself a fact: there is no
     * explanation of a signal that does not exist, and an empty list is more
     * honest than a list of factors that did not add up to it.
     */
    readonly factors: readonly ConfidenceFactor[];
    /**
     * The number, with what it is not attached.
     *
     * A percentage that means "this share of the panel, at the pessimistic
     * end of the range those votes are compatible with" and does not mean
     * "this likely to be right". A calibration block comes later that measures
     * the second thing; until it exists, this field is the warning.
     */
    readonly confidence: {
        readonly value: number;
        readonly model: ConfidenceModel;
        readonly meaning: string;
        readonly isProbabilityOfBeingRight: false;
    };
    /** The Russian sentence the dashboard shows, generated from the above. */
    readonly reason: string;
}

/**
 * What the number means, in words, per model.
 *
 * Written out rather than derived, because the whole point is that a reader
 * cannot infer it. "67%" means something different under each model and a
 * number that has to be looked up to be understood is a number that will be
 * misread.
 */
const CONFIDENCE_MEANING: Record<ConfidenceModel, string> = {
    wilson: 'Доля согласных весов, взятая с пессимистичного конца диапазона, совместимого с поданными голосами. Не вероятность того, что сигнал верен.',
    share: 'Доля веса, проголосовавшего за направление. Не вероятность того, что сигнал верен.',
    mean_conviction: 'Средняя сила голосов за направление. Не вероятность того, что сигнал верен.',
};

/**
 * Builds the explanation from the panel that produced the verdict.
 *
 * Takes the regime and the quality assessment as inputs rather than computing
 * them, because they are expensive, they are computed once per request by
 * callers that need them anyway, and recomputing them here would make a second
 * pass over the same series for a label nobody reads.
 */
export function explainSignal(input: {
    direction: IndicatorSignal;
    confidence: number;
    confidenceModel: ConfidenceModel;
    analyses: readonly IndicatorAnalysis[];
    reason: string;
    regime?: RegimeContext | null;
    quality?: QualityContext | null;
}): SignalExplanation {
    const {
        direction,
        confidence,
        confidenceModel,
        analyses,
        reason,
        regime = null,
        quality = null,
    } = input;

    const { supporting, opposing, abstaining } = partitionPanel(
        analyses,
        direction,
    );

    return {
        direction,
        supporting,
        opposing,
        abstaining,
        regime,
        quality,
        factors: confidence === 0 ? [] : confidenceFactors(supporting, opposing, quality),
        confidence: {
            value: confidence,
            model: confidenceModel,
            meaning: CONFIDENCE_MEANING[confidenceModel],
            isProbabilityOfBeingRight: false,
        },
        // The same function that built the sentence the dashboard shows, over
        // the same partition. Two strings describing one verdict, built in two
        // places, would be free to disagree — and the disagreement would be
        // between what a person reads and the arithmetic behind it.
        reason: describeSignal(
            { supporting, opposing, abstaining },
            direction,
            reason,
        ),
    };
}

/**
 * What moved the number.
 *
 * Each voter gets a share of the total weight. The supporting shares add up to
 * the gross share of the panel on the published side, and that is the figure
 * the published confidence is computed from; the confidence is then that share
 * pulled down to its pessimistic end, so the two are not equal and are not
 * meant to be. The factors explain the vote, and the confidence is the vote
 * discounted for how little a vote proves on its own.
 *
 * That the list adds up at all is the property worth asserting. A list of
 * factors a reader cannot sum is a list of impressions.
 */
function confidenceFactors(
    supporting: readonly IndicatorAnalysis[],
    opposing: readonly IndicatorAnalysis[],
    quality: QualityContext | null,
): ConfidenceFactor[] {
    const winningWeight = supporting.reduce((total, a) => total + a.weight, 0);
    const totalWeight =
        winningWeight + opposing.reduce((total, a) => total + a.weight, 0);
    const factors: ConfidenceFactor[] = [];

    if (totalWeight > 0) {
        for (const analysis of supporting) {
            factors.push({
                key: analysis.key,
                label: analysis.name,
                impact: (analysis.weight / totalWeight) * 100,
                stance: 'supporting',
                detail: analysis.reason,
            });
        }

        for (const analysis of opposing) {
            factors.push({
                key: analysis.key,
                label: analysis.name,
                // A vote against the published direction pushes the number
                // down, and showing that as a negative share is what lets the
                // list be added up.
                impact: -(analysis.weight / totalWeight) * 100,
                stance: 'opposing',
                detail: analysis.reason,
            });
        }
    }

    if (quality !== null) {
        factors.push({
            key: 'dataQuality',
            label: 'Качество данных',
            // Not additive with the panel: a bad series is a reason the panel
            // might be wrong, not a vote against it. Reported at zero impact
            // and named, so it is present in the explanation without pretending
            // to be arithmetic.
            impact: 0,
            stance: quality.usable ? 'supporting' : 'opposing',
            detail: quality.blockedBy.length > 0
                ? `Данные непригодны: ${quality.blockedBy.join(', ')}`
                : `Оценка ${quality.score.toFixed(2)}, худший фактор: ${quality.worst ?? 'нет'}`,
        });
    }

    return factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
}
