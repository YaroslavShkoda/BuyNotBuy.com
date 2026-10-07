import { z } from 'zod';
import { booleanEnv } from '../config/env.boolean.js';

/**
 * How the performance table is grouped and what it is allowed to claim.
 *
 * The buckets are the interesting part. They are not ranges chosen because
 * they look tidy on a chart: a bucket with four signals in it is four
 * observations, and a hit rate computed from it is noise with a percentage sign
 * on it. `minimumSample` is the setting that stops the system from reporting a
 * number it does not have, and it is deliberately configurable rather than
 * fixed so that an operator can be shown the difference between "no data" and
 * "a handful of signals".
 */
const PerformanceConfigSchema = z
    .object({
        /**
         * Fewer resolved signals than this and the table reports no rate at
         * all.
         *
         * Not zero and not five. Zero means every bucket of every regime has a
         * rate on it, and a reader comparing two of them is comparing one
         * signal against another. The number here is a floor on what a rate can
         * be based on, not a target the system tries to reach.
         */
        minimumSample: z.coerce.number().int().min(5).max(10_000),
        /** Edges of the confidence buckets, ascending, within 0..100. */
        confidenceEdges: z
            .array(z.coerce.number().min(0).max(100))
            .min(2)
            .max(20),
        /**
         * Whether a bucket with too few signals is reported as null or as
         * zero.
         *
         * Null, always, and that is what the setting exists to make
         * configurable-looking. A bucket of three signals reported as 0% is a
         * claim that the system is wrong in that range; null is a statement
         * that there is not enough to say. They are different sentences and a
         * dashboard must not blur them.
         */
        reportUnsampledAsNull: z.boolean(),
    })
    .refine(
        (config) =>
            config.confidenceEdges.every(
                (edge, index, all) => index === 0 || edge > (all[index - 1] ?? 0),
            ),
        {
            message: 'Confidence bucket edges must be strictly ascending',
            path: ['confidenceEdges'],
        },
    )
    .refine((config) => config.confidenceEdges[0] === 0, {
        message: 'Confidence buckets must start at 0, or signals below the first edge are unmeasured',
        path: ['confidenceEdges'],
    })
    .refine(
        (config) => config.confidenceEdges.at(-1) === 100,
        {
            message:
                'Confidence buckets must end at 100, or signals above the last edge are unmeasured',
            path: ['confidenceEdges'],
        },
    );

export type PerformanceConfig = z.infer<typeof PerformanceConfigSchema>;

export const performanceConfig: PerformanceConfig =
    PerformanceConfigSchema.parse({
        minimumSample: process.env.PERFORMANCE_MINIMUM_SAMPLE ?? '20',
        confidenceEdges: (
            process.env.PERFORMANCE_CONFIDENCE_EDGES ?? '0,25,40,55,70,85,100'
        ).split(','),
        reportUnsampledAsNull: booleanEnv('PERFORMANCE_REPORT_UNSAMPLED', true),
    });

export const PerformanceConfigParser = PerformanceConfigSchema;
