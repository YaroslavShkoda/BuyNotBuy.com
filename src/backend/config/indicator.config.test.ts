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
    'INDICATOR_ASSET_CONFIG',
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

/**
 * Per-asset thresholds, which is PHASE 7's actual request.
 *
 * The file says "configure indicators per asset"; what it names as the thing to
 * delete is a hardcoded ticker. The ticker was never there, and what stood in
 * its place was a single global configuration read in twenty-eight places —
 * none of which had a market to read it for. That is the shape of "the system
 * works for BTC", and it is a missing parameter rather than a literal.
 */
describe('per-asset thresholds', () => {
    it('ships the global configuration for a market nobody configured', async () => {
        const { signalConfigFor, INDICATOR_SIGNAL_CONFIG, hasAssetSignalConfig } =
            await loadConfig({
                INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22',
            });

        // Not a fallback for a missing setting — the answer, and recorded as
        // absent so a reader can tell it from a market that was configured.
        expect(hasAssetSignalConfig('BTCUSDT')).toBe(false);
        expect(signalConfigFor('BTCUSDT')).toEqual(INDICATOR_SIGNAL_CONFIG);
    });

    it('applies a declared override', async () => {
        const { signalConfigFor, hasAssetSignalConfig } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22+shortThreshold=74',
        });

        expect(hasAssetSignalConfig('ETHUSDT')).toBe(true);
        expect(signalConfigFor('ETHUSDT').stochastic).toMatchObject({
            longThreshold: 22,
            shortThreshold: 74,
        });
    });

    it('merges a partial override rather than dropping the rest', async () => {
        const { signalConfigFor, INDICATOR_SIGNAL_CONFIG } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22',
        });

        // Overriding one number must not silently reset the other seven to
        // nothing. A partial that replaced the group would make a run on this
        // market differ from the shipped one in ways nobody asked for.
        const resolved = signalConfigFor('ETHUSDT');

        expect(resolved.stochastic.longThreshold).toBe(22);
        expect(resolved.stochastic.shortThreshold).toBe(
            INDICATOR_SIGNAL_CONFIG.stochastic.shortThreshold,
        );
        expect(resolved.ema).toEqual(INDICATOR_SIGNAL_CONFIG.ema);
        expect(resolved.momentum).toEqual(INDICATOR_SIGNAL_CONFIG.momentum);
    });

    it('overrides more than one group at once', async () => {
        const { signalConfigFor } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22,ema:confirmBars=5',
        });

        expect(signalConfigFor('ETHUSDT').stochastic.longThreshold).toBe(22);
        expect(signalConfigFor('ETHUSDT').ema.confirmBars).toBe(5);
    });

    it('matches a market whatever case it is written in', async () => {
        // Tickers arrive from configuration, from a URL, and from a symbol the
        // exchange echoed back. A resolver that matched one spelling would
        // quietly serve the shipped thresholds for the other.
        const { signalConfigFor } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22',
        });

        expect(signalConfigFor('ethusdt').stochastic.longThreshold).toBe(22);
        expect(signalConfigFor('EtHuSdT').stochastic.longThreshold).toBe(22);
    });

    it('keeps one market override off another', async () => {
        const { signalConfigFor, INDICATOR_SIGNAL_CONFIG } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22;SOLUSDT=stochastic:longThreshold=9',
        });

        expect(signalConfigFor('ETHUSDT').stochastic.longThreshold).toBe(22);
        expect(signalConfigFor('SOLUSDT').stochastic.longThreshold).toBe(9);
        expect(signalConfigFor('BTCUSDT')).toEqual(INDICATOR_SIGNAL_CONFIG);
    });

    it('refuses a configuration it cannot read, and says what was wrong', async () => {
        // A threshold nobody can read is a threshold nobody can defend, and a
        // resolver that quietly dropped the bad clause would serve a different
        // strategy from the one the operator wrote down.
        await expect(
            loadConfig({ INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=loud' }),
        ).rejects.toThrow(/INDICATOR_ASSET_CONFIG is not valid/);
    });

    it('refuses an override outside the range a threshold can have', async () => {
        // 0..100 is not decoration: a long threshold of 400 is not a strict
        // long signal, it is a rule that never votes.
        await expect(
            loadConfig({ INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=400' }),
        ).rejects.toThrow(/INDICATOR_ASSET_CONFIG is not valid/);
    });

    it('refuses a key it does not recognise instead of ignoring it', async () => {
        await expect(
            loadConfig({ INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:wideThreshold=22' }),
        ).rejects.toThrow(/INDICATOR_ASSET_CONFIG is not valid/);
    });

    it('treats an absent setting as no settings at all', async () => {
        const { signalConfigFor, hasAssetSignalConfig } = await loadConfig();

        expect(hasAssetSignalConfig('BTCUSDT')).toBe(false);
        expect(signalConfigFor('BTCUSDT').stochastic.longThreshold).toBe(15);
    });
});

describe('the fingerprint of a configuration', () => {
    it('does not give two markets with different thresholds one version', async () => {
        // The comment in the fingerprint module explains why the rule set is in
        // the hash: without it, measurements made by different rules share a
        // version and the performance tables blend them into a series no rule
        // ever produced. The same argument covers per-asset thresholds, and
        // before this the fingerprint read the global — so a market with its
        // own thresholds and a market without produced different signals under
        // one name.
        const { signalConfigFor } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=22',
        });
        const { fingerprintStrategy } = await import('./strategy-fingerprint.js');

        const btc = fingerprintStrategy('BTCUSDT', signalConfigFor('BTCUSDT'));
        const eth = fingerprintStrategy('ETHUSDT', signalConfigFor('ETHUSDT'));

        expect(eth.hash).not.toBe(btc.hash);
    });

    it('gives an override equal to the shipped values the shipped version', async () => {
        // Otherwise writing the shipped number down explicitly would fork the
        // version space, and every stored measurement would point at a version
        // that describes the same strategy.
        const { signalConfigFor } = await loadConfig({
            INDICATOR_ASSET_CONFIG: 'ETHUSDT=stochastic:longThreshold=15+shortThreshold=80',
        });
        const { INDICATOR_SIGNAL_CONFIG } = await import('./indicator.config.js');
        const { fingerprintStrategy } = await import('./strategy-fingerprint.js');

        // Same market, so the market named in the fingerprint cannot be what makes
        // the hashes differ — which is exactly what this test has to keep honest.
        expect(
            fingerprintStrategy('BTCUSDT', signalConfigFor('ETHUSDT')).hash,
        ).toBe(fingerprintStrategy('BTCUSDT', INDICATOR_SIGNAL_CONFIG).hash);
    });

    it('keeps the shipped configuration as the default, once a market is named', async () => {
        // The market became a required parameter in round 109, because a
        // fingerprint that cannot name its market *is* the defect. The default that
        // survived is the one this test was really about: naming no signal config
        // still means the shipped configuration, so a market with no override is
        // fingerprinted as itself.
        //
        // What did not survive is the sentence above about re-versioning every
        // stored snapshot on the next boot. That re-versioning is now the intended
        // effect, forward-only: existing rows keep their hashes and their stored
        // children, and each market resolves to its own version from here on.
        const { INDICATOR_SIGNAL_CONFIG } = await loadConfig();
        const { fingerprintStrategy } = await import('./strategy-fingerprint.js');

        expect(fingerprintStrategy('BTCUSDT').hash).toBe(
            fingerprintStrategy('BTCUSDT', INDICATOR_SIGNAL_CONFIG).hash,
        );
    });

    it('and the market is the difference between two otherwise identical hashes', async () => {
        // The one-line version of the whole round: same settings, same thresholds,
        // two hashes.
        await loadConfig();
        const { fingerprintStrategy } = await import('./strategy-fingerprint.js');

        expect(fingerprintStrategy('BTCUSDT').hash).not.toBe(
            fingerprintStrategy('ETHUSDT').hash,
        );
    });
});

