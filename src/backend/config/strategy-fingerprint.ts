import { createHash } from 'node:crypto';

import { indicatorConfig, INDICATOR_SIGNAL_CONFIG } from './indicator.config.js';

/**
 * A stable fingerprint of everything that can change a signal.
 *
 * The order is fixed and the values are copied by name rather than by
 * enumeration, so a field added to `indicatorConfig` does not silently widen
 * the fingerprint and quietly re-version every snapshot. Adding a setting that
 * can change an output is a deliberate act, and it is made by adding a line
 * here.
 */
export interface StrategyFingerprint {
    /** Machine-readable, order-independent hash of every setting below. */
    hash: string;
    config: Record<string, unknown>;
}

export function fingerprintStrategy(): StrategyFingerprint {
    const config = {
        periods: {
            ema: indicatorConfig.emaPeriod,
            stochastic: indicatorConfig.stochasticPeriod,
            momentum: indicatorConfig.momentumPeriod,
            atr: indicatorConfig.atrPeriod,
            rsi: indicatorConfig.rsiPeriod,
            macdFast: indicatorConfig.macdFastPeriod,
            macdSlow: indicatorConfig.macdSlowPeriod,
            macdSignal: indicatorConfig.macdSignalPeriod,
        },
        thresholds: {
            stochasticLong: INDICATOR_SIGNAL_CONFIG.stochastic.longThreshold,
            stochasticShort: INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
            stochasticCenter: INDICATOR_SIGNAL_CONFIG.stochastic.center,
            momentumDeadbandPercent:
                INDICATOR_SIGNAL_CONFIG.momentum.deadbandPercent,
            momentumConvictionScalePercent:
                INDICATOR_SIGNAL_CONFIG.momentum.convictionScalePercent,
            emaConfirmBars: INDICATOR_SIGNAL_CONFIG.ema.confirmBars,
            emaConvictionScalePercent:
                INDICATOR_SIGNAL_CONFIG.ema.convictionScalePercent,
        },
    };

    return { hash: hashValue(config), config };
}

/**
 * Hashes a value with its keys in sorted order.
 *
 * `JSON.stringify` on an object literal is already deterministic here, but a
 * hash that changes because someone reordered a literal is a hash that will
 * eventually change by accident, and an accidental re-version of every stored
 * snapshot is not something to discover afterwards.
 */
export function hashValue(value: unknown): string {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(
        ([left], [right]) => (left < right ? -1 : 1),
    );

    return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
        .join(',')}}`;
}
