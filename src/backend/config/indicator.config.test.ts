import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
    vi.resetModules();
    const config = await import('./indicator.config.js');
    const profile = await import('./strategy.profile.js');

    return { ...config, ...profile };
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('the selected strategy profile', () => {
    it('ships the established indicator periods and signal thresholds', async () => {
        const {
            indicatorConfig,
            INDICATOR_SIGNAL_CONFIG,
            strategyProfileName,
        } = await loadConfig();

        expect(strategyProfileName).toBe('baseline');
        expect(indicatorConfig).toMatchObject({
            emaPeriod: 300,
            stochasticPeriod: 100,
            momentumPeriod: 100,
            atrPeriod: 14,
            rsiPeriod: 14,
            bollingerPeriod: 20,
            bollingerStdDev: 2,
            adxPeriod: 14,
            macdFastPeriod: 12,
            macdSlowPeriod: 26,
            macdSignalPeriod: 9,
            emaWarmupMultiplier: 3,
            divergence: {
                leftWindow: 2,
                rightWindow: 2,
                maxDistance: 5,
                maxAge: 120,
            },
        });
        expect(INDICATOR_SIGNAL_CONFIG.stochastic).toEqual({
            longThreshold: 15,
            shortThreshold: 80,
            center: 50,
        });
    });

    it('rejects a profile name it does not know', async () => {
        vi.stubEnv('STRATEGY_PROFILE', 'experimental');

        await expect(loadConfig()).rejects.toThrow(/baseline/);
    });

    it('refuses retired per-setting overrides instead of ignoring them', async () => {
        vi.stubEnv('INDICATOR_EMA_PERIOD', '600');

        await expect(loadConfig()).rejects.toThrow(/INDICATOR_EMA_PERIOD/);
    });
});

describe('derived indicator requirements', () => {
    it('uses the profile EMA warmup when calculating the candle requirement', async () => {
        const { requiredCandleCount } = await loadConfig();

        expect(requiredCandleCount()).toBe(900);
    });

    it('keeps indicator names tied to the period being described', async () => {
        const { emaDisplayName, momentumDisplayName } = await loadConfig();

        expect(emaDisplayName(300)).toBe('EMA 300');
        expect(momentumDisplayName(100)).toBe('Momentum 100');
    });
});

describe('profile asset overrides', () => {
    it('resolves a partial override without losing other profile values', async () => {
        const { INDICATOR_SIGNAL_CONFIG, resolveSignalConfig } = await loadConfig();
        const overrides = {
            ETHUSDT: { stochastic: { longThreshold: 22 } },
        };
        const resolved = resolveSignalConfig('ethusdt', overrides);

        expect(resolved.stochastic.longThreshold).toBe(22);
        expect(resolved.stochastic.shortThreshold).toBe(
            INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
        );
        expect(resolved.ema).toEqual(INDICATOR_SIGNAL_CONFIG.ema);
        expect(resolved.momentum).toEqual(INDICATOR_SIGNAL_CONFIG.momentum);
    });

    it('refuses asset thresholds that conflict with the shared center', async () => {
        const { resolveSignalConfig } = await loadConfig();

        expect(() =>
            resolveSignalConfig('ETHUSDT', {
                ETHUSDT: { stochastic: { longThreshold: 55 } },
            }),
        ).toThrow(/Stochastic long threshold/);
    });

    it('reports whether the selected profile declares an asset override', async () => {
        const { hasAssetSignalConfig } = await loadConfig();

        expect(hasAssetSignalConfig('BTCUSDT')).toBe(false);
    });
});

describe('strategy fingerprints', () => {
    it('includes resolved market thresholds and the selected profile', async () => {
        const {
            INDICATOR_SIGNAL_CONFIG,
            resolveSignalConfig,
            strategyProfileName,
        } = await loadConfig();
        const { fingerprintStrategy } = await import('./strategy-fingerprint.js');
        const baseline = fingerprintStrategy('ETHUSDT');
        const changedSignal = resolveSignalConfig('ETHUSDT', {
            ETHUSDT: { stochastic: { longThreshold: 22 } },
        });
        const changed = fingerprintStrategy('ETHUSDT', changedSignal);

        expect(baseline.hash).not.toBe(changed.hash);
        expect(baseline.config.profile).toMatchObject({
            name: strategyProfileName,
        });
        expect(
            fingerprintStrategy('BTCUSDT', INDICATOR_SIGNAL_CONFIG).hash,
        ).not.toBe(baseline.hash);
    });
});
