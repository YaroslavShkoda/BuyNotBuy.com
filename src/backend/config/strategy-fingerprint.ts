import { createHash } from 'node:crypto';
import { strategySetFingerprint } from '../strategies/strategy-fingerprint.js';
import type { ResolvedIndicatorSignalConfig } from './indicator.config.js';
import { signalConfigFor } from './indicator.config.js';
import { strategyProfile, strategyProfileName } from './strategy.profile.js';

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

/**
 * @param market the market this configuration is running on
 *
 * **Required, and that is the round.** It used to default to the shipped signal
 * config and carry no market at all, which is the whole of the finding in
 * `lifecycle/cross-asset-isolation.test.ts`: two markets running the same
 * thresholds produced one `strategy_version`, so every measurement table under it
 * blended them and the blend was a series no configuration ever produced.
 *
 * Making it required rather than optional is the point. A fingerprint that cannot
 * name its market is the defect, so an optional parameter would let the next call
 * site reintroduce it silently — and it would look correct, because the blend is
 * invisible in every individual number.
 *
 * **Forward-only, and no history is rewritten.** Existing `strategy_version` rows
 * keep their hashes and their stored children; nothing is re-attributed, because
 * old results are never rewritten. What changes is that from here on each market
 * resolves to its own version, so the ladder starts its shadow window again —
 * which is exactly what happens on any configuration change, and is what the
 * gate requires before it will approve anything.
 */
export function fingerprintStrategy(
    market: string,
    signal: ResolvedIndicatorSignalConfig = signalConfigFor(market),
): StrategyFingerprint {
    const config = {
        // First, and outside every nested block, so that two markets cannot
        // produce one hash by agreeing about everything else. Normalised, because
        // `btcusdt` and `BTCUSDT` are the same market and two versions would each
        // look like a first sighting.
        market: market.trim().toUpperCase(),
        periods: strategyProfile.indicators.periods,
        thresholds: {
            stochasticLong: signal.stochastic.longThreshold,
            stochasticShort: signal.stochastic.shortThreshold,
            stochasticCenter: signal.stochastic.center,
            momentumDeadbandPercent: signal.momentum.deadbandPercent,
            momentumConvictionScalePercent: signal.momentum.convictionScalePercent,
            emaConfirmBars: signal.ema.confirmBars,
            emaConvictionScalePercent: signal.ema.convictionScalePercent,
        },
        profile: {
            name: strategyProfileName,
            consensus: strategyProfile.consensus,
            regime: strategyProfile.regime,
            lifecycle: strategyProfile.lifecycle,
            outcome: strategyProfile.outcome,
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
