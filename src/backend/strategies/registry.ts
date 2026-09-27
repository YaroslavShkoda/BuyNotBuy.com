import { z } from 'zod';

import { createConsensusPrimary } from './consensus-primary.js';
import { createDonchian } from './donchian.js';
import { createDonchianTrendGated } from './donchian-trend-gated.js';
import { createDonchianCalmGated } from './donchian-calm-gated.js';
import {
    DONCHIAN_TREND_GATED_CONFIG,
} from './donchian-trend-gated.js';

import type { StrategyContext, StrategyDecision, StrategyKey, StrategyModule } from './types.js';
import type { ConsensusComputation } from './consensus-primary.js';

/**
 * Where strategies live, and which one speaks when.
 *
 * The point of this file is that adding a rule is an entry in one list rather
 * than an edit spread through the analysis service, the backtest and the
 * tests. A strategy that has to be wired in by hand is a strategy that is
 * wired in wrong the first time, and this repository has already produced
 * enough of those to be wary of the pattern.
 *
 * The second thing this file decides is the one that actually carries risk:
 * **what happens when the primary has no opinion.**
 *
 * A fallback that can override a real signal is a second strategy with equal
 * authority and no way to tell them apart afterwards. So the fallback is
 * confined to the gap: it may only speak when the primary said NEUTRAL, and it
 * can never overturn a signal the primary did publish. That is a rule about
 * power, not about code, and it is the reason a fallback added in March
 * cannot quietly become the thing that decides in August.
 *
 * And it is in **shadow** by default, which is the part that matters most and
 * is easiest to get wrong. The rule behind this fallback was chosen by looking
 * at a backtest, and it has never traded a single bar of live data. Promoting
 * it to publishing on the strength of a backtest is exactly the mistake the
 * whole pipeline in this project exists to prevent: a candidate that has
 * passed a backtest is a candidate, and the stages after the backtest are
 * walk-forward, shadow, approval and production. So by default the fallback is
 * evaluated, recorded and returned to the caller, and the published signal
 * stays the primary's. Turning it on is a decision made deliberately, with a
 * name attached, after watching it.
 */

export const FallbackModeSchema = z.enum(['shadow', 'active']);
export type FallbackMode = z.infer<typeof FallbackModeSchema>;

const StrategyKeySchema = z.enum([
    'consensus-primary',
    'donchian-20',
    'donchian-trend-gated',
]);

/**
 * Reads the fallback selection from the environment, validated rather than
 * parsed.
 *
 * `z.enum` rather than a default on a typo: a misspelled strategy name would
 * otherwise fall back to "no fallback", and a typo that silently disables the
 * thing you configured is the failure mode of every lenient parse. The
 * process should refuse to start and name the variable instead.
 */
function fromEnv(
    name: string,
    env: Readonly<Record<string, string | undefined>>,
): string | undefined {
    const raw = env[name];

    return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

export interface FallbackConfig {
    readonly key: StrategyKey;
    readonly mode: FallbackMode;
}

export function readFallbackConfig(
    env: Readonly<Record<string, string | undefined>> = process.env,
): FallbackConfig {
    const rawKey = fromEnv('FALLBACK_STRATEGY', env);

    if (rawKey === undefined) {
        return { key: 'donchian-trend-gated', mode: 'shadow' };
    }

    const parsed = StrategyKeySchema.safeParse(rawKey);

    if (!parsed.success) {
        throw new Error(
            `FALLBACK_STRATEGY must be one of ${StrategyKeySchema.options.join(', ')}, ` +
                `received "${rawKey}"`,
        );
    }

    const rawMode = fromEnv('FALLBACK_MODE', env) ?? 'shadow';
    const mode = FallbackModeSchema.safeParse(rawMode);

    if (!mode.success) {
        throw new Error(
            `FALLBACK_MODE must be one of ${FallbackModeSchema.options.join(', ')}, ` +
                `received "${rawMode}"`,
        );
    }

    return { key: parsed.data, mode: mode.data };
}

export type StrategyFactory = () => StrategyModule;

/**
 * The catalogue.
 *
 * One entry per strategy, and the only place a new key has to appear for it
 * to exist. Kept as factories rather than instances so that each caller gets
 * its own module and no two requests share mutable state by accident.
 *
 * The primary is the exception. Its computation is supplied by the caller
 * rather than imported, because the consensus is defined over the indicator
 * readings and the only place those exist is the analysis service. Wiring it
 * the other way would give the strategy layer a second route to the indicators,
 * and two routes become two answers the first time one of them is extended.
 */
export const STRATEGY_FACTORIES: Readonly<
    Record<Exclude<StrategyKey, 'consensus-primary'>, StrategyFactory>
> = {
    'donchian-20': () => createDonchian(),
    'donchian-trend-gated': () => createDonchianTrendGated(),
    // Selectable, not the default. The default is still the rule that loses
    // money, because a user asked for it by name and because that is how a
    // candidate arrives. This one is the version the ablation says is better
    // and the walk-forward likes most, which is exactly why it must not be
    // installed by having someone read a table and act on it.
    'donchian-calm-gated': () => createDonchianCalmGated(),
};

export interface RegistryOptions {
    /**
     * The primary's computation: the existing consensus, given the price and
     * the closes its EMA confirmation needs.
     */
    readonly consensus: ConsensusComputation;
    /** Replaces or adds a fallback strategy, by key. */
    readonly overrides?: Partial<Record<StrategyKey, StrategyFactory>>;
    readonly config?: FallbackConfig;
    /** Closures the EMA confirmation reads. Defaults to the configured three. */
    readonly emaConfirmBars?: number;
}

export interface Registry {
    readonly primary: StrategyModule;
    readonly fallback: StrategyModule | null;
    readonly config: FallbackConfig;
    get(key: StrategyKey): StrategyModule;
    keys(): readonly StrategyKey[];
}

export interface ResolvedSignal {
    /** What gets published. The primary's answer unless it had none. */
    readonly published: StrategyDecision;
    /** Which module the published answer came from. */
    readonly publishedBy: StrategyKey;
    /**
     * What the primary said, always, even when it was overruled.
     *
     * Not derivable from `published`. A caller that wanted to record both
     * answers and only had these would write the fallback's direction into both
     * fields, and the row would then show an agreement that never happened.
     */
    readonly primaryDecision: StrategyDecision;
    /** The fallback's answer, always, whether or not it was used. */
    readonly fallbackDecision: StrategyDecision | null;
    /**
     * True when the fallback would have changed the published signal but was
     * held back by shadow mode.
     *
     * The number worth watching: it is the live evidence the shadow period
     * exists to collect, and it is zero for as long as the rule agrees with
     * the primary.
     */
    readonly suppressed: boolean;
}

export function createRegistry(options: RegistryOptions): Registry {
    if (options === undefined || typeof options.consensus !== 'function') {
        throw new Error(
            'createRegistry needs the consensus computation. The primary is ' +
                'the running system, and the only caller that can supply it is ' +
                'the one that computed the indicators.',
        );
    }

    const config = options.config ?? readFallbackConfig();
    const factories: Record<StrategyKey, StrategyFactory> = {
        'consensus-primary': () =>
            createConsensusPrimary(options.consensus, {
                emaConfirmBars: options.emaConfirmBars ?? 2,
            }),
        ...STRATEGY_FACTORIES,
        ...(options.overrides ?? {}),
    };

    const built = new Map<StrategyKey, StrategyModule>();

    const get = (key: StrategyKey): StrategyModule => {
        const existing = built.get(key);

        if (existing !== undefined) {
            return existing;
        }

        const factory = factories[key];

        if (factory === undefined) {
            throw new Error(`No strategy is registered under "${key}"`);
        }

        const module = factory();

        // The mechanism is the one thing a module cannot be allowed to omit,
        // and this is the only place that can be enforced. An empty string
        // passes a type check, so a registry that only checked types would
        // accept a rule nobody can reason about when it fails.
        if (module.mechanism.trim().length < 40) {
            throw new Error(
                `Strategy "${key}" must state why it should make money. ` +
                    `A rule with no stated mechanism is a fitted curve.`,
            );
        }

        built.set(key, module);

        return module;
    };

    const primary = get('consensus-primary');

    if (config.key === 'consensus-primary') {
        throw new Error(
            'FALLBACK_STRATEGY cannot be the primary. A fallback that can ' +
                'overrule the primary is a second strategy with equal ' +
                'authority and no way to tell the two apart afterwards.',
        );
    }

    // Built eagerly. A module that violates the contract has to be found when
    // the registry is assembled, not the first time a request happens to reach
    // it — the second is a production outage caused by a mistake that review
    // was always going to catch.
    for (const key of Object.keys(factories) as StrategyKey[]) {
        get(key);
    }

    return {
        primary,
        fallback: get(config.key),
        config,
        get,
        keys: () => Object.keys(factories) as readonly StrategyKey[],
    };
}

/**
 * Runs the primary, and the fallback only if the primary had nothing to say.
 *
 * The fallback is evaluated in shadow mode too, and deliberately so: a shadow
 * that skips the evaluation when the primary had an opinion would only record
 * the cases where it was already irrelevant, and the disagreements — the only
 * informative ones — would be exactly what it failed to collect.
 */
export function resolveSignal(
    registry: Registry,
    context: StrategyContext,
): ResolvedSignal {
    const primaryDecision = registry.primary.evaluate(context);

    if (registry.fallback === null) {
        return {
            published: primaryDecision,
            publishedBy: registry.primary.key,
            primaryDecision,
            fallbackDecision: null,
            suppressed: false,
        };
    }

    const fallbackDecision = registry.fallback.evaluate(context);

    if (primaryDecision.direction !== 'NEUTRAL') {
        return {
            published: primaryDecision,
            publishedBy: registry.primary.key,
            primaryDecision,
            fallbackDecision,
            suppressed: false,
        };
    }

    if (
        fallbackDecision.direction === 'NEUTRAL' ||
        registry.config.mode === 'shadow'
    ) {
        return {
            published: primaryDecision,
            publishedBy: registry.primary.key,
            primaryDecision,
            fallbackDecision,
            suppressed: fallbackDecision.direction !== 'NEUTRAL',
        };
    }

    return {
        published: fallbackDecision,
        publishedBy: registry.fallback.key,
        // Carried explicitly, because "the primary said one thing and the
        // fallback another" is the fact the decision log exists to record, and
        // inferring it from `published` would write the fallback's answer over
        // the primary's and turn a disagreement into an agreement.
        primaryDecision,
        fallbackDecision,
        suppressed: false,
    };
}

let shared: Registry | null = null;

/**
 * Production's registry, built once.
 *
 * Assembled by `configureRegistry` rather than here, because the consensus
 * computation needs the indicators and only the analysis service has them.
 * Calling this before `configureRegistry` is a programming error and says so,
 * rather than building a registry whose primary throws on first use — which
 * would be discovered on the first request instead of at startup.
 */
export function getRegistry(): Registry {
    if (shared === null) {
        throw new Error(
            'The strategy registry has not been configured. Call ' +
                'configureRegistry() during startup with the consensus ' +
                'computation before the first analysis.',
        );
    }

    return shared;
}

export function configureRegistry(options: RegistryOptions): Registry {
    shared = createRegistry(options);

    return shared;
}

/** Test seam: the singleton exists so production shares one, not so tests share configuration. */
export function resetRegistry(): void {
    shared = null;
}

export { DONCHIAN_TREND_GATED_CONFIG };
export type { StrategyModule, StrategyKey, StrategyContext, StrategyDecision };
