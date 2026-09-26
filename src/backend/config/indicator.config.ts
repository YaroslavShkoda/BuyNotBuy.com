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
