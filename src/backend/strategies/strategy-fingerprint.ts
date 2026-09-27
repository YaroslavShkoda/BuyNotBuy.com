import { readFallbackConfig } from './registry.js';

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
        installed: ['consensus-primary', 'donchian-20', 'donchian-trend-gated'],
        fallback: config.key,
        mode: config.mode,
    };
}
