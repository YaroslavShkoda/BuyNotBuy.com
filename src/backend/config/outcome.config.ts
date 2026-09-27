import { z } from 'zod';

/**
 * How far out a signal is measured, and how close counts as right.
 *
 * The horizons are in bars and configurable because a system that only knows
 * about one horizon cannot be compared with one that knows about several: every
 * backtest that claims an edge has to say at what distance it was right, and a
 * single fixed number makes that claim impossible to check.
 *
 * `breakevenPercent` is the threshold a return has to clear before it counts as
 * correct, and it is not zero. Fees and spread are real, a return of zero
 * after costs is a loss, and a table that scores a flat trade as a win will
 * report a strategy as profitable that loses money on every trade it takes.
 */
const OutcomeConfigSchema = z
    .object({
        /**
         * Bars out to measure, in order.
         *
         * Sorted and de-duplicated rather than trusted: a horizon list out of
         * order makes "the first one that has data" depend on how the operator
         * typed the setting, and an unsorted table is unreadable besides.
         */
        horizons: z
            .array(z.coerce.number().int().positive())
            .min(1)
            .max(32),
        /**
         * Return a trade has to beat to count as correct, as a fraction.
         *
         * Charged against the return, not added to the cost model: this block
         * measures what happened, and what it cost is the backtest's business.
         * A number recorded here is a measurement and a number recorded there
         * is an assumption, and mixing them means a performance table cannot be
         * recomputed when the fee schedule changes.
         */
        breakevenPercent: z.coerce.number().min(0).max(100),
        /**
         * Whether to compute the best and worst the price did in between.
         *
         * Off by default and cheap to turn on, because the two together are
         * what tells a system to have been right: a signal that reaches its
         * target on the third bar and comes back is a different result from one
         * that holds, and a table showing only the endpoint cannot tell them
         * apart.
         */
        trackExcursions: z.coerce.boolean(),
    })
    .transform((config) => ({
        ...config,
        horizons: [...new Set(config.horizons)].sort((a, b) => a - b),
    }))
    .refine((config) => config.horizons.length > 0, {
        message: 'At least one horizon is required',
        path: ['horizons'],
    });

export type OutcomeConfig = z.infer<typeof OutcomeConfigSchema>;

export const outcomeConfig: OutcomeConfig = OutcomeConfigSchema.parse({
    horizons: (
        process.env.OUTCOME_HORIZONS ?? '1,3,6,12,24,48,72'
    ).split(','),
    // One tenth of a percent: roughly the round trip on a liquid venue. A
    // trade that did not clear this did not pay for itself.
    breakevenPercent: process.env.OUTCOME_BREAKEVEN_PERCENT ?? '0.1',
    trackExcursions: process.env.OUTCOME_TRACK_EXCURSIONS ?? 'true',
});

export const OutcomeConfigParser = OutcomeConfigSchema;
