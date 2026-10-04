import type { IndicatorSignalOverrides, ResolvedIndicatorSignalConfig } from '../config/indicator.config.js';

import {
    emaDisplayName,
    INDICATOR_SIGNAL_CONFIG,
    indicatorConfig,
    momentumDisplayName,
} from '../config/indicator.config.js';
import type { MarketIndicators } from '../indicators/indicator.service.js';
import {
    calculateConsensus,
    clampWeight,
} from './consensus.js';
import type {
    IndicatorAnalysis,
    SignalResult,
} from './signal.types.js';

function conviction(
    distance: number,
    fullScale: number,
): number {
    if (fullScale <= 0) {
        return 0;
    }

    return clampWeight(Math.abs(distance) / fullScale);
}

function analyzeEMA(
    price: number,
    ema: number,
    recentCloses: number[],
    config: ResolvedIndicatorSignalConfig,
): IndicatorAnalysis {
    const name = emaDisplayName(indicatorConfig.emaPeriod);
    const confirmBars = config.ema.confirmBars;
    const scale = config.ema.convictionScalePercent;

    if (!Number.isFinite(price) || !Number.isFinite(ema) || ema <= 0 || price <= 0) {
        // `ema <= 0` alone is not enough: every comparison against NaN is
        // false, so a NaN average would sail past the guard and be reported as
        // a working indicator that simply could not find a side.
        return {
            key: 'ema',
            name,
            signal: 'NEUTRAL',
            reason: `${name} недоступна`,
            weight: 0,
        };
    }

    const closes = recentCloses.length > 0
        ? recentCloses.slice(-confirmBars)
        : [price];

    const above = closes.filter(
        (close) => close > ema,
    ).length;
    const below = closes.filter(
        (close) => close < ema,
    ).length;

    const distancePercent = ((price - ema) / ema) * 100;
    const weight = conviction(distancePercent, scale);

    if (above === closes.length) {
        return {
            key: 'ema',
            name,
            signal: 'LONG',
            reason: `Цена выше ${name} (${closes.length} закрытия подряд)`,
            weight,
        };
    }

    if (below === closes.length) {
        return {
            key: 'ema',
            name,
            signal: 'SHORT',
            reason: `Цена ниже ${name} (${closes.length} закрытия подряд)`,
            weight,
        };
    }

    return {
        key: 'ema',
        name,
        signal: 'NEUTRAL',
        reason: `Цена не удерживается по одну сторону ${name} ${closes.length} закрытий подряд`,
        weight: 0,
    };
}

function analyzeStochastic(
    stochastic: number,
    config: ResolvedIndicatorSignalConfig,
): IndicatorAnalysis {
    const name = 'Стохастик';
    const {
        longThreshold,
        shortThreshold,
        center,
    } = config.stochastic;

    // A value that is not a number is not a reading in the middle of the range.
    // Left unguarded it would fall through both comparisons and land in the
    // neutral zone below, which claims the indicator read the data and found
    // nothing — a different statement from "this could not be computed".
    if (!Number.isFinite(stochastic)) {
        return {
            key: 'stochastic',
            name,
            signal: 'NEUTRAL',
            reason: 'Стохастик недоступен',
            weight: 0,
        };
    }

    const weight = conviction(
        stochastic - center,
        Math.max(center, 100 - center),
    );

    if (stochastic < longThreshold) {
        return {
            key: 'stochastic',
            name,
            signal: 'LONG',
            reason: `Стохастик ниже ${longThreshold}`,
            weight,
        };
    }

    if (stochastic > shortThreshold) {
        return {
            key: 'stochastic',
            name,
            signal: 'SHORT',
            reason: `Стохастик выше ${shortThreshold}`,
            weight,
        };
    }

    return {
        key: 'stochastic',
        name,
        signal: 'NEUTRAL',
        reason: 'Стохастик находится в нейтральной зоне',
        weight: 0,
    };
}

function analyzeMomentum(
    momentum: number,
    config: ResolvedIndicatorSignalConfig,
): IndicatorAnalysis {
    const name = momentumDisplayName(indicatorConfig.momentumPeriod);
    const {
        deadbandPercent,
        convictionScalePercent,
    } = config.momentum;

    // The deadband below is `Math.abs(momentum) <= deadband`, and every
    // comparison against NaN is false — so a non-finite momentum skipped the
    // deadband, skipped the positive branch, and fell into the negative one.
    // The indicator reported SHORT with the reason "Momentum ниже 0" for a
    // value that is not below zero and not above it either. The consensus
    // happened to survive it, because a single voter cannot make a majority,
    // but the per-indicator line is shown on the dashboard and it was simply
    // untrue.
    if (!Number.isFinite(momentum)) {
        return {
            key: 'momentum',
            name,
            signal: 'NEUTRAL',
            reason: `${name} недоступен`,
            weight: 0,
        };
    }

    // A rate of change measured in hundredths of a percent is noise, not a
    // trend. Without the deadband it flipped the headline signal on rounding.
    if (Math.abs(momentum) <= deadbandPercent) {
        return {
            key: 'momentum',
            name,
            signal: 'NEUTRAL',
            reason: `Momentum в нейтральной зоне ±${deadbandPercent}%`,
            weight: 0,
        };
    }

    const weight = conviction(momentum, convictionScalePercent);

    if (momentum > 0) {
        return {
            key: 'momentum',
            name,
            signal: 'LONG',
            reason: 'Momentum выше 0',
            weight,
        };
    }

    return {
        key: 'momentum',
        name,
        signal: 'SHORT',
        reason: 'Momentum ниже 0',
        weight,
    };
}

/**
 * @param overrides Thresholds merged over the shipped configuration.
 *
 * Two kinds of caller, and the comment above used to deny the second existed.
 * The walk-forward search passes a *partial* pair it chose from the grid; the
 * live pipeline passes the market's *resolved* configuration from
 * `signalConfigFor`, which is already merged and is accepted here because
 * spreading a complete configuration over the shipped one yields itself.
 *
 * So the live pipeline's signals are the configured ones and not a fitted
 * variant — that part was true — but the claim rested on "never passes these",
 * which stopped being true the moment a market could have thresholds of its own.
 * A market configured with its own thresholds is not a fitted variant, and
 * saying the pipeline never overrides anything was a way of not having to say
 * whose thresholds it uses.
 */
export function calculateSignal(
    price: number,
    indicators: MarketIndicators,
    recentCloses: number[] = [],
    overrides?: IndicatorSignalOverrides,
): SignalResult {
    const config = resolveConfig(overrides);

    const indicatorAnalyses = [
        analyzeEMA(price, indicators.ema, recentCloses, config),
        analyzeStochastic(indicators.stochastic, config),
        analyzeMomentum(indicators.momentum, config),
    ];

    const consensus = calculateConsensus(indicatorAnalyses);

    return {
        ...consensus,
        indicators: indicatorAnalyses,
    };
}

/** One level deep, so an override may replace a whole group or one number. */
function resolveConfig(
    overrides: IndicatorSignalOverrides | undefined,
): ResolvedIndicatorSignalConfig {
    if (overrides === undefined) {
        return INDICATOR_SIGNAL_CONFIG;
    }

    return {
        stochastic: {
            ...INDICATOR_SIGNAL_CONFIG.stochastic,
            ...overrides.stochastic,
        },
        ema: {
            ...INDICATOR_SIGNAL_CONFIG.ema,
            ...overrides.ema,
        },
        momentum: {
            ...INDICATOR_SIGNAL_CONFIG.momentum,
            ...overrides.momentum,
        },
    };
}
