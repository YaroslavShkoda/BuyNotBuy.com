import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A strategy version per market, or the market that has thresholds of its own
 * quietly runs the shipped ones.
 *
 * PHASE 8 asks for `strategy × asset × version` to coexist. Measured before
 * anything was changed, and the mechanism was already built — which is why this
 * reads as a wiring defect rather than a design one:
 *
 * - `config/indicator.config.ts` resolves per-market thresholds:
 *   `signalConfigFor('ETHUSDT')` and `hasAssetSignalConfig('ETHUSDT')`.
 * - `config/strategy-fingerprint.ts` takes that resolved config as an
 *   argument, and its own comment says why it must: a fingerprint that did not
 *   say which thresholds were in force "would give two different strategies one
 *   version".
 * - `signals/signal.service.ts` takes the overrides too.
 *
 * And the production callers passed none of it. `resolveActive()` called
 * `fingerprintStrategy()` with no argument, so it fingerprinted the global
 * defaults whatever the market was; `analysis.service.ts` called
 * `calculateSignal(price, indicators, closes)` and left the fifth parameter
 * off. The only caller that resolved a market's thresholds was
 * `backtest/backtest.service.ts` — so **a configured `ETHUSDT` override changed
 * the backtest and changed nothing in production**, and the two paths disagreed
 * about the same strategy.
 *
 * `hasAssetSignalConfig` had no production caller at all, and it is exactly the
 * flag that would have announced "this market runs a different configuration".
 * `research/uncalled-exports.sweep.ts` listed it, and the round that listed it
 * could not tell that the thing it pointed at was load-bearing.
 */

/** Fresh registry: the overrides are parsed once, at import time. */
async function withOverrides<T>(env: Record<string, string>, run: () => Promise<T>) {
    vi.resetModules();

    for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
    }

    try {
        return await run();
    } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
    }
}

const ETH_OVERRIDE = 'ETHUSDT=stochastic:longThreshold=22';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('a market with thresholds of its own gets its own strategy version', () => {
    it('resolves two versions, one per configuration', async () => {
        await withOverrides({ INDICATOR_ASSET_CONFIG: ETH_OVERRIDE }, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );

            const repository = createStrategyVersionRepository();

            const btc = await repository.resolveActive('BTCUSDT');
            const eth = await repository.resolveActive('ETHUSDT');

            // Same strategy, same shape — and two different answers, because the
            // two markets do not run the same thresholds. Sharing one row here is
            // the defect the fingerprint's argument exists to prevent.
            expect(eth.configHash).not.toBe(btc.configHash);
            expect(eth.id).not.toBe(btc.id);
        });
    });

    it('stores the thresholds it resolved, not the shipped ones', async () => {
        await withOverrides({ INDICATOR_ASSET_CONFIG: ETH_OVERRIDE }, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );
            const { query } = await import('../db/pool.js');

            const eth = await createStrategyVersionRepository().resolveActive('ETHUSDT');

            const stored = await query<{ config: { thresholds: { stochasticLong: number } } }>(
                `SELECT config FROM strategy_version WHERE id = $1`,
                [eth.id],
            );

            expect(stored.rows[0]?.config.thresholds.stochasticLong).toBe(22);
        });
    });

    it('gives the same answer twice for one market', async () => {
        await withOverrides({ INDICATOR_ASSET_CONFIG: ETH_OVERRIDE }, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );

            const repository = createStrategyVersionRepository();

            expect((await repository.resolveActive('ETHUSDT')).id).toBe(
                (await repository.resolveActive('ETHUSDT')).id,
            );
        });
    });
});

describe('a market nobody configured runs the shipped configuration', () => {
    it('still gets a version of its own, because the market is part of it', async () => {
        // **This test used to assert the opposite, and its reason has been
        // reversed rather than invalidated.**
        //
        // It read: "No override means no difference to record, so no difference to
        // make: inventing one here would give every unconfigured market a version
        // of its own and make the table unreadable." Two claims, and both were
        // wrong in the same direction.
        //
        // "No difference to record" — a market running BTC's thresholds on ETH is
        // a different series, and every measurement taken under it belongs to
        // ETH. Recording that it is not BTC's measurements is not inventing a
        // difference; it is refusing to lose one. The blend it prevented is the
        // subject of `lifecycle/cross-asset-isolation.test.ts`.
        //
        // "Make the table unreadable" — the table is keyed by `config_hash` and
        // holds a handful of rows. One row per market is not unreadable; one row
        // covering every market is a row whose measurements cannot be attributed
        // to anything. The cost was never tidiness, it was meaning.
        await withOverrides({ INDICATOR_ASSET_CONFIG: ETH_OVERRIDE }, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );

            const repository = createStrategyVersionRepository();

            expect((await repository.resolveActive('BTCUSDT')).id).not.toBe(
                (await repository.resolveActive('XRPUSDT')).id,
            );
        });
    });

    it('and unchanged by the mere presence of another market override', async () => {
        await withOverrides({ INDICATOR_ASSET_CONFIG: ETH_OVERRIDE }, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );
            const { fingerprintStrategy, hashValue } = await import(
                '../config/strategy-fingerprint.js'
            );

            const withOverridePresent = await createStrategyVersionRepository().resolveActive(
                'BTCUSDT',
            );
            // The market is named on both sides, because it is part of the
            // fingerprint now — so this compares like with like and still asks the
            // question it was written for: another market's override must not
            // change *this* market's version.
            const fingerprintOfShippedConfig = fingerprintStrategy('BTCUSDT');

            expect(withOverridePresent.configHash).toBe(fingerprintOfShippedConfig.hash);
            expect(withOverridePresent.configHash).toBe(hashValue(fingerprintOfShippedConfig.config));
        });
    });

    it('and two markets with identical settings get two versions', async () => {
        // **The round.** `strategy_version` had no market in it, so BTCUSDT and
        // ETHUSDT running the same thresholds shared one row, and every
        // measurement table under it blended them — a series no configuration
        // produced, with every individual number correct.
        //
        // The repository already took an instrument and already resolved per-market
        // thresholds. What it did not do was record which market the version was
        // for, so two markets that resolve to the same settings collapsed onto one
        // row. Forward-only: nothing is re-attributed, and the rows that already
        // exist keep their hashes.
        await withOverrides({}, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );
            const repository = createStrategyVersionRepository();

            const btc = await repository.resolveActive('BTCUSDT');
            const eth = await repository.resolveActive('ETHUSDT');

            expect(eth.id).not.toBe(btc.id);
        });

        // And the same market asked twice is still one version, or the ladder
        // would never accumulate evidence at all.
        await withOverrides({}, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );
            const repository = createStrategyVersionRepository();

            expect((await repository.resolveActive('BTCUSDT')).id).toBe(
                (await repository.resolveActive('BTCUSDT')).id,
            );
        });
    });

    it('and one market written two ways is still one version', async () => {
        // Case is not a fork. `BTCUSDT` and `btcusdt` are the same market, and
        // two versions would each believe they were this market's first sighting.
        await withOverrides({}, async () => {
            const { createStrategyVersionRepository } = await import(
                './strategy-version.repository.js'
            );
            const repository = createStrategyVersionRepository();

            expect((await repository.resolveActive('BTCUSDT')).id).toBe(
                (await repository.resolveActive(' btcusdt ')).id,
            );
        });
    });
});