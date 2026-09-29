import { createHash } from 'node:crypto';

import { indicatorConfig, INDICATOR_SIGNAL_CONFIG } from './indicator.config.js';

import { strategySetFingerprint } from '../strategies/strategy-fingerprint.js';

import type { ResolvedIndicatorSignalConfig } from './indicator.config.js';

/**
 * A stable fingerprint of everything that can change a signal.
 *
 * The order is fixed and the values are copied by name rather than by
 * enumeration, so a field added to `indicatorConfig` does not silently widen
 * the fingerprint and quietly re-version every snapshot. Adding a setting that
 * can change an output is a deliberate act, and it is made by adding a line
 * here.
 *
 * **The thresholds arrive as an argument rather than being read from here.**
 * Per-asset overrides mean the shipped configuration is no longer the only
 * configuration: a market with its own thresholds produces a different signal,
 * and a fingerprint that did not say so would give two different strategies one
 * version. The comment below explains why the rule set is in this hash, and the
 * same argument covers the thresholds — a table that blended them would be a
 * series no configuration ever produced, with every individual number right.
 */
export interface StrategyFingerprint {
    /** Machine-readable, order-independent hash of every setting below. */
    hash: string;
    config: Record<string, unknown>;
}

export function fingerprintStrategy(
    signal: ResolvedIndicatorSignalConfig = INDICATOR_SIGNAL_CONFIG,
): StrategyFingerprint {
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
            stochasticLong: signal.stochastic.longThreshold,
            stochasticShort: signal.stochastic.shortThreshold,
            stochasticCenter: signal.stochastic.center,
            momentumDeadbandPercent: signal.momentum.deadbandPercent,
            momentumConvictionScalePercent: signal.momentum.convictionScalePercent,
            emaConfirmBars: signal.ema.confirmBars,
            emaConvictionScalePercent: signal.ema.convictionScalePercent,
        },
        // Which rules are installed, which one is the fallback, and whether it
        // is allowed to publish. Part of the configuration for the same reason
        // a period is: it changes what a measurement means.
        //
        // Without this, a measurement produced by the consensus alone and one
        // produced by the consensus plus a fallback would share a version, the
        // performance tables would blend them, and the blend would be a series
        // that no rule ever produced. The individual numbers would be right and
        // the question they answered would be unaskable.
        strategies: strategySetFingerprint(),
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
