import { z } from 'zod';

import { INDICATOR_SIGNAL_CONFIG } from './indicator.config.js';

/**
 * Which parameters may be tuned at all, and over what range.
 *
 * A registry rather than a free search, because the interesting failure is not
 * a bad parameter value — it is a good one found by a search that was allowed
 * to look everywhere. Anything the optimiser can reach is a parameter the
 * system has an opinion about, and the opinion is recorded here with its
 * bounds, its step and the value production actually ships.
 *
 * `production` is part of the definition rather than a field filled in
 * afterwards. A parameter that can be tuned but has no shipped value is one
 * nobody decided should be the default, and a parameter whose shipped value is
 * outside its own searchable range is a configuration the optimiser can never
 * reproduce, which means the backtest and the product are being measured on
 * different strategies.
 */

export const ParameterSpecSchema = z
    .object({
        key: z.string().min(1),
        /** Human-readable, in the report's language. */
        label: z.string().min(1),
        min: z.coerce.number(),
        max: z.coerce.number(),
        step: z.coerce.number().positive(),
        /** The value the running system uses. */
        production: z.coerce.number(),
        /**
         * Whether the optimiser may move this at all.
         *
         * A parameter can be listed and locked. That is not a contradiction:
         * a locked parameter is one somebody has decided is a property of the
         * market rather than a knob, and keeping it in the registry says so
         * where a reader will look.
         */
        tunable: z.coerce.boolean(),
    })
    .refine((spec) => spec.min <= spec.max, {
        message: 'Parameter has a minimum above its maximum',
        path: ['min'],
    })
    .refine((spec) => spec.max - spec.min >= spec.step, {
        message:
            'Parameter is narrower than one step, so it has no values to search',
        path: ['step'],
    })
    .refine((spec) => spec.production >= spec.min && spec.production <= spec.max, {
        // Not a nicety. A shipped value outside its own range means the
        // optimiser cannot reproduce the product, so a backtest that found
        // the best value in the range is reporting on a strategy nobody runs.
        // The path is what names the parameter, and it is what a reader
        // looks at, so the message does not have to interpolate it.
        message:
            'Parameter ships at a value its own search range cannot reach',
        path: ['production'],
    })
    .refine(
        (spec) =>
            Math.abs(
                (spec.production - spec.min) / spec.step -
                    Math.round((spec.production - spec.min) / spec.step),
            ) < 1e-9,
        {
            // A step that does not divide the range evenly means the grid is
            // misaligned and the shipped value is not on it.
            message: 'Parameter ships at a value that is not on its own grid',
            path: ['production'],
        },
    );

export type ParameterSpec = z.infer<typeof ParameterSpecSchema>;

const PARAMETER_REGISTRY = ParameterSpecSchema.array().parse([
    {
        key: 'stochastic.longThreshold',
        label: 'Стохастик: порог входа в лонг',
        min: 5,
        max: 40,
        step: 5,
        // Taken from the shipped indicator configuration rather than written
        // out, so the registry cannot quietly describe a different product
        // from the one that is running. A registry that hardcodes 15 while the
        // system ships 20 is a search over a product nobody has.
        production: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
        tunable: true,
    },
    {
        key: 'stochastic.shortThreshold',
        label: 'Стохастик: порог входа в шорт',
        min: 60,
        max: 95,
        step: 5,
        production: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
        tunable: true,
    },
    {
        key: 'ema.confirmBars',
        label: 'EMA: бары подтверждения расхождения',
        // Step 1, not 2: the shipped value is 3, and a range of 2..10 by twos
        // holds 2, 4, 6, 8, 10 — the configuration the product runs is not one
        // of the points its own registry can name. The refine that rejects
        // that is not a formality; it is this exact mistake, caught before
        // anybody wrote a search against the range.
        min: 2,
        max: 10,
        step: 1,
        production: INDICATOR_SIGNAL_CONFIG.ema.confirmBars,
        tunable: false,
    },
]);

export const PARAMETERS: readonly ParameterSpec[] = PARAMETER_REGISTRY;

export const TUNABLE_PARAMETERS: readonly ParameterSpec[] =
    PARAMETERS.filter((spec) => spec.tunable);

/**
 * Every value the grid can take, smallest first.
 *
 * Built from the spec rather than handed in, because a grid typed out beside
 * the spec is a second source of truth that will disagree with the first. The
 * count is reported next to the values so a search that is suddenly hundreds
 * of combinations long is visible in the output rather than in a wall clock.
 */
export function parameterGrid(spec: ParameterSpec): number[] {
    // Generated by index rather than by repeated addition. Accumulating a
    // fractional step walks off the grid, and a half-step tolerance to
    // compensate lets a point *past* the maximum through: min 1, max 8, step 4
    // produced 1, 5, 9 — and a search that reports 9 as a legal value of a
    // range ending at 8 is searching somewhere nobody chose.
    const count = Math.floor((spec.max - spec.min) / spec.step + 1e-9);
    const values: number[] = [];

    for (let index = 0; index <= count; index += 1) {
        values.push(Number((spec.min + index * spec.step).toFixed(10)));
    }

    return values;
}

export function parameterByKey(key: string): ParameterSpec | undefined {
    return PARAMETERS.find((spec) => spec.key === key);
}

export const ParameterRegistrySchema = z.object({
    parameters: z.array(ParameterSpecSchema),
});

export const ParameterSpecParser = ParameterSpecSchema;
