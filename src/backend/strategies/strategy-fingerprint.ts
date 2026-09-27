import { readFallbackConfig, STRATEGY_FACTORIES } from './registry.js';

import type { StrategyKey } from './types.js';

/**
 * The strategy half of the configuration fingerprint.
 *
 * Split into its own file on purpose. The config-side fingerprint is imported
 * by the strategy version repository, which everything under `config/` sits
 * behind. Importing the registry from there would make the fingerprint depend
 * on the strategies, which depend on the indicators, which depend on the
 * config — and that cycle surfaces as an undefined binding at startup rather
 * than as a compile error.
 */
export function strategySetFingerprint(): {
    installed: readonly StrategyKey[];
    fallback: StrategyKey;
    mode: 'shadow' | 'active';
} {
    const config = readFallbackConfig();

    return {
        // Read off the registry rather than written out here. A hand-kept list
        // is wrong the moment a rule is added, and wrong silently: the
        // configuration hash would not change, no new `strategy_version` row
        // would appear, and every signal from that point on would be filed
        // under a configuration in which the new rule does not exist. That is
        // the precise failure this hash was added to prevent, reintroduced by
        // the list that feeds it.
        installed: ['consensus-primary', ...Object.keys(STRATEGY_FACTORIES)].sort(
            (a, b) => a.localeCompare(b),
        ) as readonly StrategyKey[],
        fallback: config.key,
        mode: config.mode,
    };
}
