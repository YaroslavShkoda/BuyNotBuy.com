import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The periods are read from the environment once, at import time, so each case
 * needs a fresh module registry. `vi.resetModules()` gives one; without it a
 * case would keep the configuration the previous case happened to load and
 * would pass for the wrong reason.
 */
const ENV_NAMES = [
    'INDICATOR_EMA_PERIOD',
    'INDICATOR_STOCHASTIC_PERIOD',
    'INDICATOR_MOMENTUM_PERIOD',
    'INDICATOR_EMA_WARMUP_MULTIPLIER',
    'INDICATOR_DIVERGENCE_LEFT_WINDOW',
    'INDICATOR_DIVERGENCE_RIGHT_WINDOW',
    'INDICATOR_DIVERGENCE_MAX_DISTANCE',
    'INDICATOR_DIVERGENCE_MAX_AGE',
] as const;

async function loadConfig(env: Record<string, string> = {}) {
    vi.resetModules();

    for (const name of ENV_NAMES) {
        vi.stubEnv(name, '');
    }

    for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
    }

    return import('./indicator.config.js');
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('indicator periods from the environment', () => {
    it('ships the periods it has always shipped', async () => {
        const { indicatorConfig } = await loadConfig();

        expect(indicatorConfig.emaPeriod).toBe(300);
        expect(indicatorConfig.stochasticPeriod).toBe(100);
        expect(indicatorConfig.momentumPeriod).toBe(100);
        expect(indicatorConfig.emaWarmupMultiplier).toBe(3);
        expect(indicatorConfig.divergence.maxAge).toBe(120);
    });

    it('takes a period from the environment', async () => {
        const { indicatorConfig } = await loadConfig({ INDICATOR_MOMENTUM_PERIOD: '50' });

        expect(indicatorConfig.momentumPeriod).toBe(50);
    });

    it('recomputes the candle requirement when the EMA period grows', async () => {
        const { requiredCandleCount } = await loadConfig({ INDICATOR_EMA_PERIOD: '600' });

        // 600 x 3. Missing this link is how a longer EMA ends up silently
        // seeded from a shorter window, which is the exact bug the warm-up
        // multiplier exists to prevent.
        expect(requiredCandleCount()).toBe(1800);
    });

    it('stops the process on a period that is not a positive number', async () => {
        await expect(loadConfig({ INDICATOR_EMA_PERIOD: 'abc' })).rejects.toThrow(
            /INDICATOR_EMA_PERIOD/,
        );
    });

    it('stops the process on a period of zero', async () => {
        // Zero would not crash. It would make the indicator agree with itself.
        await expect(loadConfig({ INDICATOR_MOMENTUM_PERIOD: '0' })).rejects.toThrow(
            /INDICATOR_MOMENTUM_PERIOD/,
        );
    });

    it('stops the process on a fractional period', async () => {
        await expect(loadConfig({ INDICATOR_EMA_PERIOD: '14.5' })).rejects.toThrow(
            /INDICATOR_EMA_PERIOD/,
        );
    });

    it('stops the process on a negative period', async () => {
        await expect(loadConfig({ INDICATOR_DIVERGENCE_MAX_AGE: '-1' })).rejects.toThrow(
            /INDICATOR_DIVERGENCE_MAX_AGE/,
        );
    });

    it('ignores an empty value rather than reading it as zero', async () => {
        const { indicatorConfig } = await loadConfig({ INDICATOR_EMA_PERIOD: '' });

        // An empty variable in a .env file is far more common than a deliberate
        // zero, and it must mean "use the default", not "period zero".
        expect(indicatorConfig.emaPeriod).toBe(300);
    });

    it('tolerates surrounding whitespace', async () => {
        const { indicatorConfig } = await loadConfig({ INDICATOR_MOMENTUM_PERIOD: ' 42 ' });

        expect(indicatorConfig.momentumPeriod).toBe(42);
    });
});

describe('display names follow the period', () => {
    it('keeps the shipped labels with the shipped periods', async () => {
        const { emaDisplayName, momentumDisplayName } = await loadConfig();

        expect(emaDisplayName(300)).toBe('EMA 300');
        expect(momentumDisplayName(100)).toBe('Momentum 100');
    });

    it('names the period that is actually in use', async () => {
        const { emaDisplayName, momentumDisplayName } = await loadConfig({
            INDICATOR_MOMENTUM_PERIOD: '50',
        });

        // A label hardcoding "100" while the configuration says 50 is a label
        // that lies about what was computed.
        expect(momentumDisplayName(50)).toBe('Momentum 50');
        expect(momentumDisplayName(50)).not.toBe('Momentum 100');
        expect(emaDisplayName(300)).toBe('EMA 300');
    });
});
