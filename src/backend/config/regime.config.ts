import { z } from 'zod';
import { strategyProfile } from './strategy.profile.js';

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
     * How far back the volatility baseline reaches, in days.
     *
     * **In days rather than bars, and the distinction is the whole point.** The
     * baseline was 720 bars with the comment "30 days of hourly bars" — which
     * is 30 days on exactly one timeframe. On a daily chart it is two years, and
     * on a minute chart it is twelve hours, so the number the configuration
     * stated an intent for was not the number any other chart was computing.
     *
     * The boundaries themselves did not have this problem and still do not: they
     * are multiples of the instrument's own median, and ADX is 0..100 everywhere
     * by construction. This is about the *window*, which is a property of the
     * timeframe rather than of the market — so a market never needed its own
     * regime thresholds, and a timeframe does need its own baseline.
     */
    baselineDays: z.coerce.number().int().positive(),
    /**
     * A regime built from fewer bars than this is reported as unknown.
     *
     * Because a baseline of three bars called "normal volatility" is a
     * statement about three bars, and reporting it as a regime is how a
     * young table starts classifying itself.
     */
    minimumDays: z.coerce.number().int().positive(),
    /**
     * The bars these work out to on a one-hour chart.
     *
     * Kept because they are the numbers the shipped configuration was tuned
     * against and what every stored reading was computed with. A change to
     * `regimeWindowFor` that moved these would silently re-label every
     * historical regime, and rule: old results are never rewritten.
     */
    baselineBars: z.coerce.number().int().positive(),
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
}).refine((config) => config.minimumDays <= config.baselineDays, {
    message: 'Regime minimum days must not exceed the baseline length',
    path: ['minimumDays'],
});

export type RegimeConfig = z.infer<typeof RegimeConfigSchema>;

export const regimeConfig: RegimeConfig = RegimeConfigSchema.parse({
    ...strategyProfile.regime,
});

/** The bar length of an interval, in milliseconds. */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The bars a day of the given timeframe is made of.
 *
 * **`1h` is the answer when nothing is known, and it is the answer on purpose.**
 * Every reading stored so far was computed on a one-hour baseline, so a caller
 * that does not name its timeframe gets those numbers back and not a different
 * regime. Guessing a timeframe from the length of the series would relabel
 * history, and a rule that may not change what has already been measured is
 * worth more here than completeness.
 */
export function barsPerDay(interval: string | undefined): number {
    const cleaned = (interval ?? '1h').trim().toLowerCase();

    // Written as a division rather than a counted number, because the count is
    // the thing being asserted and the division is the thing being relied on: a
    // day of minutes is 1440 on any clock, and a bare 1440 would be one to
    // check rather than one to read.
    const perDay = (lengthMs: number): number => Math.round(DAY_MS / lengthMs);

    switch (cleaned) {
        case '1m':
            return perDay(MINUTE_MS);
        case '5m':
            return perDay(5 * MINUTE_MS);
        case '15m':
            return perDay(15 * MINUTE_MS);
        case '1h':
            return perDay(HOUR_MS);
        case '4h':
            return perDay(4 * HOUR_MS);
        case '1d':
            return perDay(DAY_MS);
        default:
            // An interval nobody has a length for is asked for as hourly, and
            // the reading says how many bars it actually used — a wrong label in
            // the output is recoverable, a silently wrong baseline is not.
            return perDay(HOUR_MS);
    }
}

/**
 * The window this regime is measured over, on a given timeframe.
 *
 * Never smaller than what the shipped configuration used, because a window that
 * shrank would start calling quiet markets ordinary on the strength of less
 * history than before — the same label, computed from less evidence.
 */
export function regimeWindowFor(interval: string | undefined): {
    baselineBars: number;
    minimumBars: number;
} {
    const perDay = barsPerDay(interval);

    return {
        baselineBars: Math.max(regimeConfig.baselineBars, regimeConfig.baselineDays * perDay),
        minimumBars: Math.max(regimeConfig.minimumBars, regimeConfig.minimumDays * perDay),
    };
}
