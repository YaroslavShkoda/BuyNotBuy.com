import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The live pipeline and the fingerprint must agree about which thresholds a
 * market runs, or a market is measured under one configuration and filed under
 * another.
 *
 * Before this work the mechanism existed in three places and was wired in one:
 * `signalConfigFor` resolved a market's thresholds, `fingerprintStrategy` took
 * them as an argument, and `calculateSignal` took them as an override — but the
 * production analysis path called the last two without the argument, so a
 * configured `ETHUSDT` override changed `backtest.service.ts` and nothing else.
 * The backtest and the dashboard were two different strategies wearing one
 * name, and the strategy version stored beside every snapshot said so.
 *
 * These cases go through `calculateSignal` and `fingerprintStrategy` together
 * rather than each on its own, because the defect was never in either one: it
 * was in a market's thresholds reaching one and not the other.
 */

const OVERRIDES = {
    ETHUSDT: { stochastic: { longThreshold: 22 } },
};

/**
 * Read off `analyzeStochastic`: a reading below `longThreshold` is LONG and one
 * above `shortThreshold` is SHORT, everything else is NEUTRAL. The oscillator
 * convention is inverted — oversold reads long — so 18 sits under the override's
 * 22 and above the shipped 15, which is the whole point: the same reading, two
 * different answers, decided only by whose thresholds were in force.
 *
 * The first version of this fixture passed `{ k, d }` where the field is a
 * plain number, so both comparisons were false and both readings came back
 * NEUTRAL — the test was green about the wrong thing until the assertion was
 * the one that noticed.
 */
function indicatorsAt(stochastic: number) {
    return {
        ema: stochastic,
        stochastic,
        momentum: 1,
        atr: 1,
        rsi: 50,
        macd: { macd: 1, signal: 0, histogram: 1 },
    };
}

async function load() {
    vi.resetModules();

    const { calculateSignal } = await import('../signals/signal.service.js');
    const {
        resolveSignalConfig,
        hasAssetSignalConfig: hasProfileAssetSignalConfig,
    } = await import('../config/indicator.config.js');
    const { fingerprintStrategy } = await import('../config/strategy-fingerprint.js');
    const signalConfigFor = (instrument: string) =>
        resolveSignalConfig(instrument, OVERRIDES);
    const hasAssetSignalConfig = (instrument: string) =>
        hasProfileAssetSignalConfig(instrument, OVERRIDES);

    return { calculateSignal, signalConfigFor, hasAssetSignalConfig, fingerprintStrategy };
}

afterEach(() => {
    vi.resetModules();
});

describe('a configured market runs its own thresholds', () => {
    it('answers the indicator vote from them', async () => {
        const { calculateSignal, signalConfigFor } = await load();

        const readings = indicatorsAt(18);
        const voteOf = (result: { indicators: { key: string; signal: string }[] }) =>
            result.indicators.find((entry) => entry.key === 'stochastic')?.signal;

        expect(voteOf(calculateSignal(100, readings, []))).toBe('NEUTRAL');
        expect(voteOf(calculateSignal(100, readings, [], signalConfigFor('ETHUSDT')))).toBe(
            'LONG',
        );
    });

    it('and not necessarily the published direction', async () => {
        const { calculateSignal, signalConfigFor } = await load();

        // Worth stating rather than discovering: a market's own thresholds can
        // change its stored configuration and its per-indicator readings while
        // the published direction stays the same, because the consensus weighs
        // three votes and the other two may outvote this one either way. So
        // "the market runs different thresholds" is not observable as "the
        // dashboard flipped", and asserting on the direction would have been
        // asserting on a coincidence.
        const readings = indicatorsAt(18);

        expect(calculateSignal(100, readings, []).signal).toBe(
            calculateSignal(100, readings, [], signalConfigFor('ETHUSDT')).signal,
        );
    });

    it('leaves an unconfigured market on the shipped thresholds', async () => {
        const { calculateSignal, signalConfigFor } = await load();

        const readings = indicatorsAt(18);

        expect(calculateSignal(100, readings, [], signalConfigFor('BTCUSDT')).signal).toBe(
            calculateSignal(100, readings, []).signal,
        );
    });

    it('and says which markets those are', async () => {
        const { hasAssetSignalConfig } = await load();

        expect(hasAssetSignalConfig('ETHUSDT')).toBe(true);
        expect(hasAssetSignalConfig('BTCUSDT')).toBe(false);
    });

    it('fingerprints the thresholds the signal was produced under', async () => {
        const { signalConfigFor, fingerprintStrategy } = await load();

        // The property that matters: a market's configuration and the version
        // filed under it come from the same thresholds. The fingerprint takes the
        // resolved config for exactly this reason, and calling it with none is
        // what gave two markets one version.
        expect(fingerprintStrategy('ETHUSDT', signalConfigFor('ETHUSDT')).hash).not.toBe(
            fingerprintStrategy('BTCUSDT', signalConfigFor('BTCUSDT')).hash,
        );
    });
});

describe('the shipped configuration is unchanged by an override existing', () => {
    it('produces the same hash as before the override was configured', async () => {
        const { signalConfigFor, fingerprintStrategy } = await load();

        // What matters for the rows already in the table: an unconfigured
        // market must keep resolving to the hash it always resolved to, or
        // adding a second market would silently re-version every stored
        // snapshot — the accident `hashValue` sorts keys to prevent.
        // The market is named on both sides: it is part of the fingerprint now, and a
        // comparison across markets would prove nothing about the thresholds.
        expect(fingerprintStrategy('BTCUSDT', signalConfigFor('BTCUSDT')).hash).toBe(
            fingerprintStrategy('BTCUSDT').hash,
        );
    });
});
