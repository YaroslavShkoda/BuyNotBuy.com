import type { MarketIndicators } from '../indicators/indicator.service.js';

import {
    INDICATOR_SIGNAL_CONFIG,
    emaDisplayName,
    indicatorConfig,
    momentumDisplayName,
} from '../config/indicator.config.js';

import {
    calculateConsensus,
    clampWeight,
} from './consensus.js';

import type { IndicatorSignalOverrides, ResolvedIndicatorSignalConfig } from '../config/indicator.config.js';
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
    ema300: number,
    recentCloses: number[],
    config: ResolvedIndicatorSignalConfig,
): IndicatorAnalysis {
    const name = emaDisplayName(indicatorConfig.emaPeriod);
    const confirmBars = config.ema.confirmBars;
    const scale = config.ema.convictionScalePercent;

    if (ema300 <= 0 || price <= 0) {
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
        (close) => close > ema300,
    ).length;
    const below = closes.filter(
        (close) => close < ema300,
    ).length;

    const distancePercent = ((price - ema300) / ema300) * 100;
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
 * @param overrides Threshold overrides, merged over the shipped
 * configuration. Only the walk-forward search passes these; the live pipeline
 * never does, so the dashboard's signals are the configured ones and not a
 * fitted variant.
 */
export function calculateSignal(
    price: number,
    indicators: MarketIndicators,
    recentCloses: number[] = [],
    overrides?: IndicatorSignalOverrides,
): SignalResult {
    const config = resolveConfig(overrides);

    const indicatorAnalyses = [
        analyzeEMA(price, indicators.ema300, recentCloses, config),
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
