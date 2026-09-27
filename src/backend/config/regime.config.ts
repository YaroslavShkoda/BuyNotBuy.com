import { z } from 'zod';

/**
 * What "unusual" means, and where those numbers are allowed to come from.
 *
 * The thresholds are the interesting part, and they are configuration for a
 * reason that is not "flexibility". A regime boundary is a claim about what is
 * normal for this instrument, and what is normal for BTC hourly is not what is
 * normal for an hourly alt. Hard-coding the boundaries means the answer is
 * about the author's market rather than about this one.
 *
 * Validated at the boundary for the same reason as every other setting here: a
 * threshold set backwards — low above high — produces a regime that can never
 * be assigned, and it would do so silently, every request, forever.
 */
const RegimeConfigSchema = z.object({
    /**
     * Volatility boundaries, as a multiple of the instrument's own median.
     *
     * A multiple of the instrument's own history rather than an absolute
     * percentage, because "2% is high" means nothing without saying high
     * compared to what.
     */
    volatility: z.object({
        // Below 0.5x its own median the market is genuinely quiet. Note that
        // this is not 1: a median splits its own data, so a boundary set at 1
        // would read NORMAL only for markets travelling *more* than typical,
        // and call half of all markets LOW. The label has to be a band the
        // middle of the distribution can land in.
        normal: z.coerce.number().positive(),
        high: z.coerce.number().positive(),
        extreme: z.coerce.number().positive(),
    }),
    /**
     * ADX boundaries. Absolute, because ADX is already scale-free: it is
     * 0..100 on every instrument by construction.
     */
    trend: z.object({
        /** Below this there is no trend worth calling one. */
        weak: z.coerce.number().min(0).max(100),
        /** Above this the trend is strong. */
        strong: z.coerce.number().min(0).max(100),
    }),
    /**
     * How far the directional balance has to favour one side before the
     * trend is given a direction at all.
     *
     * Separate from ADX on purpose. ADX says there is a trend; this says which
     * way, and a market with +DI 51 and -DI 49 has a strong trend pointing
     * nowhere, which is a real and common thing.
     */
    directional: z.coerce.number().min(0).max(100),
    /**
     * How many bars the volatility baseline is measured over.
     *
     * Long enough that one violent afternoon is not itself the new normal.
     */
    baselineBars: z.coerce.number().int().positive(),
    /**
     * A regime built from fewer bars than this is reported as unknown.
     *
     * Because a baseline of three bars called "normal volatility" is a
     * statement about three bars, and reporting it as a regime is how a
     * young table starts classifying itself.
     */
    minimumBars: z.coerce.number().int().positive(),
}).refine((config) => config.volatility.normal < config.volatility.high, {
    message: 'Volatility normal threshold must be below the high threshold',
    path: ['volatility', 'normal'],
}).refine((config) => config.volatility.high < config.volatility.extreme, {
    message: 'Volatility high threshold must be below the extreme threshold',
    path: ['volatility', 'high'],
}).refine((config) => config.trend.weak < config.trend.strong, {
    message: 'Trend weak threshold must be below the strong threshold',
    path: ['trend', 'weak'],
}).refine((config) => config.minimumBars <= config.baselineBars, {
    message: 'Regime minimum bars must not exceed the baseline length',
    path: ['minimumBars'],
});

export type RegimeConfig = z.infer<typeof RegimeConfigSchema>;

export const regimeConfig: RegimeConfig = RegimeConfigSchema.parse({
    volatility: {
        // 0.5x is "genuinely quiet", 1.0x is this market's own median, and the
        // bands above it are the customary "busy" and "something is wrong"
        // boundaries.
        normal: process.env.REGIME_VOLATILITY_NORMAL ?? '0.5',
        high: process.env.REGIME_VOLATILITY_HIGH ?? '1.5',
        extreme: process.env.REGIME_VOLATILITY_EXTREME ?? '2.5',
    },
    trend: {
        // Wilder's own convention, and 50 is where a trend stops being
        // ordinary rather than merely present.
        weak: process.env.REGIME_TREND_WEAK ?? '25',
        strong: process.env.REGIME_TREND_STRONG ?? '50',
    },
    directional: process.env.REGIME_DIRECTIONAL ?? '60',
    // 30 days of hourly bars. Short enough to follow a regime change, long
    // enough that the baseline is not itself a reaction.
    baselineBars: process.env.REGIME_BASELINE_BARS ?? '720',
    minimumBars: process.env.REGIME_MINIMUM_BARS ?? '50',
});
