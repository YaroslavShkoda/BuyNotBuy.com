import { z } from 'zod';

/**
 * A positive whole number, read from the environment when it is set.
 *
 * Read once at import time, and validated rather than parsed leniently: a typo
 * that produced a period of `0` would not crash, it would make an indicator
 * silently agree with itself, and a period of `abc` would make every request a
 * 500. A configuration mistake should stop the process with a message that
 * names the variable, while the process is still starting.
 */
function periodFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    const parsed = z.coerce.number().int().positive().safeParse(raw.trim());

    if (!parsed.success) {
        throw new Error(
            `${name} must be a positive whole number, received "${raw}"`,
        );
    }

    return parsed.data;
}

/**
 * A number of standard deviations, read from the environment when it is set.
 *
 * Zero is allowed here and is not allowed for a period: zero bands are a
 * meaningful, if useless, answer, and a negative width is not. The distinction
 * is worth keeping rather than folding both into `periodFromEnv`, where a
 * valid zero would be rejected.
 */
function deviationFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    const parsed = z.coerce.number().min(0).safeParse(raw.trim());

    if (!parsed.success) {
        throw new Error(
            `${name} must be a number of standard deviations, received "${raw}"`,
        );
    }

    return parsed.data;
}

/**
 * Single source of truth for indicator periods.
 *
 * The warm-up multiplier is the important part. An EMA seeded with the SMA of
 * its first `period` values only converges to the real EMA after several
 * periods of recursion. With period = 300 and a 300-bar window the recursion
 * loop runs zero times, so "EMA 300" was arithmetically identical to SMA-300
 * and drifted with the window instead of tracking price.
 */
export const indicatorConfig = {
    emaPeriod: periodFromEnv('INDICATOR_EMA_PERIOD', 300),
    stochasticPeriod: periodFromEnv('INDICATOR_STOCHASTIC_PERIOD', 100),
    momentumPeriod: periodFromEnv('INDICATOR_MOMENTUM_PERIOD', 100),
    atrPeriod: periodFromEnv('INDICATOR_ATR_PERIOD', 14),
    rsiPeriod: periodFromEnv('INDICATOR_RSI_PERIOD', 14),
    bollingerPeriod: periodFromEnv('INDICATOR_BOLLINGER_PERIOD', 20),
    /**
     * Standard deviations for the bands. Two is Bollinger's own; one and a half
     * is a tighter envelope, and it is configurable because the right answer is
     * a statement about the instrument rather than a constant in the code.
     */
    bollingerStdDev: deviationFromEnv('INDICATOR_BOLLINGER_STDDEV', 2),
    adxPeriod: periodFromEnv('INDICATOR_ADX_PERIOD', 14),
    macdFastPeriod: periodFromEnv('INDICATOR_MACD_FAST_PERIOD', 12),
    macdSlowPeriod: periodFromEnv('INDICATOR_MACD_SLOW_PERIOD', 26),
    macdSignalPeriod: periodFromEnv('INDICATOR_MACD_SIGNAL_PERIOD', 9),
    /** Three periods of history are enough to wash out the SMA seed. */
    emaWarmupMultiplier: periodFromEnv('INDICATOR_EMA_WARMUP_MULTIPLIER', 3),
    divergence: {
        leftWindow: periodFromEnv('INDICATOR_DIVERGENCE_LEFT_WINDOW', 2),
        rightWindow: periodFromEnv('INDICATOR_DIVERGENCE_RIGHT_WINDOW', 2),
        maxDistance: periodFromEnv('INDICATOR_DIVERGENCE_MAX_DISTANCE', 5),
        /**
         * How many bars a confirmed pivot may stay relevant, counted from the
         * bar that confirmed it. Without this the dashboard kept showing
         * formations from days ago as if they were forming now.
         */
        maxAge: periodFromEnv('INDICATOR_DIVERGENCE_MAX_AGE', 120),
    },
} as const;

/**
 * Thresholds that decide when an indicator votes, and how strongly. Kept next
 * to the periods so a signal can be traced back to a single constant instead
 * of a literal buried in a branch.
 */
export const INDICATOR_SIGNAL_CONFIG = {
    stochastic: {
        longThreshold: 15,
        shortThreshold: 80,
        /** Midline the conviction is measured from. */
        center: 50,
    },
    ema: {
        /**
         * Consecutive closes on one side of the EMA required before the vote
         * counts. Without it a single wick through the average flipped the
         * headline signal back and forth on every scan.
         */
        confirmBars: 3,
        /** Distance from the EMA, in percent, that scores full conviction. */
        convictionScalePercent: 2,
    },
    momentum: {
        /** Percent within which momentum is noise and abstains. */
        deadbandPercent: 0.15,
        /** Percent at which momentum reaches full conviction. */
        convictionScalePercent: 3,
    },
} as const;

export type IndicatorSignalConfig = typeof INDICATOR_SIGNAL_CONFIG;

/**
 * Display names built from the periods they describe.
 *
 * The period is part of what a reader is told, so a name that hardcodes "300"
 * while the configuration says something else is a label that lies. Deriving
 * the name from the period keeps the two in step: with the shipped periods this
 * produces exactly the strings the dashboard has always shown.
 */
export function emaDisplayName(period: number): string {
    return `EMA ${period}`;
}

export function momentumDisplayName(period: number): string {
    return `Momentum ${period}`;
}

/**
 * The same shape with widened numbers.
 *
 * `IndicatorSignalConfig` is `as const`, so its fields are the literal types
 * 15 and 80. That is right for the shipped configuration and wrong for
 * anything the caller may change: a search over thresholds hands in numbers
 * computed at runtime, and comparing those to a literal type would reject
 * every value the product did not ship with.
 */
export interface ResolvedIndicatorSignalConfig {
    stochastic: {
        longThreshold: number;
        shortThreshold: number;
        center: number;
    };
    ema: {
        confirmBars: number;
        convictionScalePercent: number;
    };
    momentum: {
        deadbandPercent: number;
        convictionScalePercent: number;
    };
}

/**
 * A partial override, at both levels.
 *
 * One level of partiality is not enough: a search over a single threshold
 * would otherwise have to restate the other five constants to satisfy the
 * type, and would silently drift from the shipped configuration.
 */
export interface IndicatorSignalOverrides {
    stochastic?: Partial<ResolvedIndicatorSignalConfig['stochastic']>;
    ema?: Partial<ResolvedIndicatorSignalConfig['ema']>;
    momentum?: Partial<ResolvedIndicatorSignalConfig['momentum']>;
}

/**
 * Candidate threshold pairs the walk-forward search is allowed to choose from.
 *
 * A grid, and a small one on purpose: a wider search fits the training window
 * more precisely and generalises less. The fixed configuration has to stay in
 * the grid, or a walk-forward run would report a fitted strategy while the
 * product ships the fixed one.
 */
export const STOCHASTIC_THRESHOLD_GRID: readonly {
    longThreshold: number;
    shortThreshold: number;
}[] = [
    { longThreshold: 5, shortThreshold: 95 },
    { longThreshold: 10, shortThreshold: 90 },
    { longThreshold: 15, shortThreshold: 85 },
    { longThreshold: 20, shortThreshold: 80 },
    { longThreshold: 25, shortThreshold: 75 },
    { longThreshold: 10, shortThreshold: 80 },
    { longThreshold: 15, shortThreshold: 80 },
    { longThreshold: 20, shortThreshold: 70 },
];

/**
 * Per-asset threshold overrides, declared rather than learned.
 *
 * **Nothing here is fitted from data, and that is the whole point.** The
 * project's own first rule forbids a system that quietly tunes itself; learning
 * each asset's thresholds from its own outcomes is that, in miniature, wearing a
 * configuration file. So an override is something a person wrote down and can
 * defend, exactly like the venue capabilities M3 introduced: declared, not
 * discovered.
 *
 * An asset with no entry gets the shipped configuration unchanged. That is not a
 * fallback for a missing setting — it is the answer, and it is recorded as
 * `null` rather than as "the nearest one" so a reader can tell the difference
 * between a market that was configured and a market nobody has thought about.
 */
const IndicatorOverrideSchema = z
    .object({
        stochastic: z
            .object({
                longThreshold: z.coerce.number().min(0).max(100).optional(),
                shortThreshold: z.coerce.number().min(0).max(100).optional(),
                center: z.coerce.number().min(0).max(100).optional(),
            })
            .strict()
            .optional(),
        ema: z
            .object({
                confirmBars: z.coerce.number().int().min(1).max(50).optional(),
                convictionScalePercent: z.coerce.number().min(0).max(100).optional(),
            })
            .strict()
            .optional(),
        momentum: z
            .object({
                deadbandPercent: z.coerce.number().min(0).max(100).optional(),
                convictionScalePercent: z.coerce.number().min(0).max(1000).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const IndicatorOverridesSchema = z.record(z.string().min(1), IndicatorOverrideSchema);

/** `ASSET` or `ASSET=...`, so a market can be named on its own or with settings. */
function parseIndicatorOverrides(
    raw: string | undefined,
): Record<string, IndicatorSignalOverrides> {
    if (raw === undefined || raw.trim() === '') {
        return {};
    }

    const parsed: Record<string, unknown> = {};

    for (const clause of raw.split(';')) {
        const trimmed = clause.trim();

        if (trimmed === '') {
            continue;
        }

        const equals = trimmed.indexOf('=');
        const instrument = (equals === -1 ? trimmed : trimmed.slice(0, equals)).trim();
        const body = equals === -1 ? '' : trimmed.slice(equals + 1).trim();
        /** Each override group is `group:key=value;key=value`. */
        const overrides: Record<string, unknown> = {};

        for (const group of body === '' ? [] : body.split(',')) {
            const colon = group.indexOf(':');
            const name = colon === -1 ? group : group.slice(0, colon);
            const pairs = colon === -1 ? group : group.slice(colon + 1);

            for (const pair of pairs.split('+')) {
                const pairEquals = pair.indexOf('=');

                if (pairEquals === -1) {
                    continue;
                }

                const key = pair.slice(0, pairEquals).trim();
                const value = pair.slice(pairEquals + 1).trim();

                if (key === '' || value === '') {
                    continue;
                }

                const group_ = overrides[name.trim()] ?? {};

                Object.assign(group_, { [key]: value });
                overrides[name.trim()] = group_;
            }
        }

        parsed[instrument] = Object.keys(overrides).length === 0 ? {} : overrides;
    }

    const result = IndicatorOverridesSchema.safeParse(parsed);

    if (!result.success) {
        throw new Error(
            `INDICATOR_ASSET_CONFIG is not valid: ${z.prettifyError(result.error)}. ` +
                'Format: ASSET=stochastic:longThreshold=20+shortThreshold=75;ASSET2',
        );
    }

    return dropUndefined(result.data) as Record<string, IndicatorSignalOverrides>;
}

/**
 * Removes keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so a property that is *optional* is not
 * the same as one that may hold `undefined` — and Zod's `.optional()` produces
 * the second. Left alone, every parsed override would be a type error, which is
 * the compiler correctly refusing a value that says "set" about something that
 * was never set. Dropping the key says the true thing: absent.
 */
function dropUndefined(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return value;
    }

    const out: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === undefined) {
            continue;
        }

        out[key] = dropUndefined(entry);
    }

    return out;
}

export const INDICATOR_ASSET_CONFIG = parseIndicatorOverrides(
    process.env['INDICATOR_ASSET_CONFIG'],
);

/**
 * The thresholds in force for one market.
 *
 * **Returns the shipped configuration for an asset nobody has configured, and
 * the configured one otherwise, with no third answer.** The absence of an entry
 * is not an error and not a near miss: a market the system has not been taught
 * about runs the configuration it ships with, and says so by having no override
 * rather than by having an empty one.
 */
export function signalConfigFor(instrument: string): ResolvedIndicatorSignalConfig {
    const override = INDICATOR_ASSET_CONFIG[instrument.toUpperCase()];

    if (override === undefined) {
        return INDICATOR_SIGNAL_CONFIG;
    }

    return {
        stochastic: {
            ...INDICATOR_SIGNAL_CONFIG.stochastic,
            ...override.stochastic,
        },
        ema: { ...INDICATOR_SIGNAL_CONFIG.ema, ...override.ema },
        momentum: { ...INDICATOR_SIGNAL_CONFIG.momentum, ...override.momentum },
    };
}

/** Whether this market has thresholds of its own, or runs the shipped ones. */
export function hasAssetSignalConfig(instrument: string): boolean {
    return INDICATOR_ASSET_CONFIG[instrument.toUpperCase()] !== undefined;
}

/**
 * Minimum number of candles the indicator pipeline needs to produce a
 * meaningful EMA. Served by the market layer, verified by the indicator layer.
 */
export function requiredCandleCount(): number {
    return Math.max(
        indicatorConfig.emaPeriod * indicatorConfig.emaWarmupMultiplier,
        indicatorConfig.stochasticPeriod,
        indicatorConfig.momentumPeriod + 1,
        // MACD needs its slow EMA plus a full signal window on top, or the
        // signal line is an average of a MACD line that barely exists.
        indicatorConfig.macdSlowPeriod + indicatorConfig.macdSignalPeriod,
        indicatorConfig.rsiPeriod + 1,
        indicatorConfig.atrPeriod + 1,
    );
}
