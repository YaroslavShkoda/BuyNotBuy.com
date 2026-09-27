import { z } from 'zod';

/**
 * How the consensus turns votes into a published signal.
 *
 * Everything here has a default, and the defaults are the arithmetic that has
 * been shipping since the first release. That is deliberate: this block makes
 * the engine configurable, and a configurable engine whose defaults quietly
 * mean something else is a way of changing every historical signal without
 * changing a line of business code. A test re-derives the old algorithm
 * independently and checks the defaults against it over every reachable vote
 * pattern, so "the defaults did not change" is a measurement.
 *
 * The settings are separated by the question each one answers. How many
 * indicators must agree is a statement about what counts as agreement. How a
 * vote's strength is counted is a statement about what a strong vote is worth.
 * How the number is reported is a statement about what the number means. They
 * are three different decisions and putting them under one number would make
 * changing one of them change the other two.
 */

/**
 * What one agreeing indicator is worth.
 *
 * `continuous` is the original: the distance from the line, scaled to the
 * configured full-scale distance, so an indicator far from its signal counts
 * for more than one that has just crossed. `binary` counts every vote as one,
 * which discards that information and is occasionally the right thing when the
 * distance from a line is mostly noise. `sqrt` is the middle: it keeps the
 * ordering between weak and strong votes while refusing to let a single far
 * vote dominate a panel, which is what a linear scale lets happen.
 */
const WeightModelSchema = z.enum(['continuous', 'binary', 'sqrt']);

/**
 * What the published number means.
 *
 * `wilson` is the original: the pessimistic end of the range compatible with
 * the votes cast, so two-to-one cannot be presented as two-thirds certainty.
 * `share` is the raw winning share, which is higher and easier to read, and is
 * wrong in the specific way that a small unanimous panel looks conclusive.
 * `mean_conviction` is the average strength of the agreeing indicators, which
 * says something different again: how sure the panel is, rather than how much
 * of the panel is on one side.
 */
const ConfidenceModelSchema = z.enum([
    'wilson',
    'share',
    'mean_conviction',
]);

const ConsensusConfigSchema = z
    .object({
        minimumAgreeing: z.coerce.number().int().positive().max(100),
        minimumMeanConviction: z.coerce.number().min(0).max(1),
        weightModel: WeightModelSchema,
        confidenceModel: ConfidenceModelSchema,
    })
    .refine(
        (config) =>
            !(config.minimumAgreeing === 1 && config.minimumMeanConviction === 0),
        {
            // Both off together means the first indicator to say anything
            // publishes the signal, and nothing downstream can tell the
            // difference between that and a panel agreeing. There is no
            // sensible reason to want it, so it is a startup failure rather
            // than a setting somebody discovers on a live dashboard.
            message:
                'A consensus with no agreement floor and no conviction floor publishes the first vote that arrives',
            path: ['minimumAgreeing'],
        },
    );

export type ConsensusConfig = z.infer<typeof ConsensusConfigSchema>;
export type WeightModel = z.infer<typeof WeightModelSchema>;
export type ConfidenceModel = z.infer<typeof ConfidenceModelSchema>;

export const consensusConfig: ConsensusConfig = ConsensusConfigSchema.parse({
    // Two of three, and a single indicator is an opinion rather than a
    // consensus — this used to be the most common state of the dashboard.
    minimumAgreeing: process.env.CONSENSUS_MIN_AGREEING ?? '2',
    minimumMeanConviction: process.env.CONSENSUS_MIN_CONVICTION ?? '0.25',
    weightModel: process.env.CONSENSUS_WEIGHT_MODEL ?? 'continuous',
    confidenceModel: process.env.CONSENSUS_CONFIDENCE_MODEL ?? 'wilson',
});

export const ConsensusConfigParser = ConsensusConfigSchema;
