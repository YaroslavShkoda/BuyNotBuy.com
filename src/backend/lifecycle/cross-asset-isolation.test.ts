import { beforeEach, describe, expect, it } from 'vitest';

import { createEvidenceReader } from './evidence.repository.js';
import { fingerprintStrategy } from '../config/strategy-fingerprint.js';

import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

const NOW = 1_760_000_000_000;

/**
 * Cross-asset isolation, the class the roadmap calls the most valuable one
 * because data mixed between assets does not look broken.
 *
 * I went looking for a table that forgot to carry an asset, and there is none:
 * every measurement table has a `symbol`. So the mixing is not in the storage.
 * It is in what a **strategy version** is, and it follows from the fingerprint
 * rather than from any query.
 *
 * `fingerprintStrategy` deliberately includes everything that changes what a
 * measurement *means* — every indicator period, every threshold, which rules are
 * installed, which is the fallback — and says why in its own comment: without
 * them "the performance tables would blend them, and the blend would be a series
 * that no rule ever produced". Applied to the asset axis, that same standard is
 * not met. The fingerprint has no symbol, no asset, no instrument, so one
 * `strategy_version` is one row covering every asset the system trades.
 *
 * The consequence is below, and it is not a hypothetical: `evidenceFor` has no
 * asset parameter at all, and its tally counts every symbol under the version.
 *
 * **This test does not change it, and round 106 did not either.** Splitting the
 * version per asset is a decision with a migration behind it — every stored
 * `strategy_version`, `signal_state`, `signal_snapshot` and `signal_outcome` would
 * have to be re-attributed, and old results are never rewritten. What the test does
 * is put the blend where it can be seen, with the number, instead of leaving it to
 * be discovered later as a win rate nobody can reproduce on any single asset.
 *
 * Round 106 gave `evidenceFor` an optional market, and the promotion gate now uses
 * it — so a promotion is judged on the market it is granted for rather than on a
 * blend. That is the half of the finding that needed no migration and no decision.
 * What is still true, and still asserted here, is that a **version** has no market:
 * an unscoped read blends, and this file is what keeps that visible instead of
 * letting a fixed gate quietly imply the structure was fixed too.
 */
describe('two assets under one strategy version', () => {
    const pool = getTestPool();
    const reader = createEvidenceReader();

    const aVersion = async (): Promise<number> => {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO strategy_version (created_at, name, description, config, config_hash)
             VALUES ($1, 'v', '', '{}'::jsonb, $2) RETURNING id`,
            [NOW, `v-${Math.random()}`],
        );

        return Number(rows[0]?.id);
    };

    const aSignal = async (series: string, versionId: number): Promise<string> => {
        const snap = await pool.query<{ id: string }>(
            `INSERT INTO signal_snapshot
                 (symbol, provider, interval, strategy_version_id, input_hash,
                  snapshot, first_candle_ts, last_candle_ts, candle_count,
                  candles_hash, created_at)
             VALUES ($1, 'binance', '1h', $2, $3, '{}'::jsonb, $4, $4, 1, 'c', $4)
             RETURNING id`,
            [series, versionId, `snap-${series}-${Math.random()}`, NOW],
        );

        const state = await pool.query<{ id: string }>(
            `INSERT INTO signal_state
                 (symbol, provider, interval, direction, status, snapshot_id, price,
                  confidence, published_at, candle_timestamp, created_at, updated_at)
             VALUES ($1, 'binance', '1h', 'LONG', 'EXPIRED', $2, 100, 0.8, $3, $3, $3, $3)
             RETURNING id`,
            [series, snap.rows[0]?.id, NOW],
        );

        return String(state.rows[0]?.id);
    };

    const measured = async (
        series: string,
        stateId: string,
        versionId: number,
        verdict: string,
    ): Promise<void> => {
        await pool.query(
            `INSERT INTO signal_outcome
                 (symbol, provider, interval, signal_state_id, direction, verdict,
                  horizon_bars, entry_timestamp, entry_price, closed_by,
                  strategy_version_id, created_at, updated_at)
             VALUES ($1, 'binance', '1h', $2, 'LONG', $3, 72, $4, 100,
                     'expired', $5, $4, $4)`,
            [series, stateId, verdict, NOW, versionId],
        );
    };

    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('fingerprints the same configuration for every asset', () => {
        // The cause, one layer up from the tally. The fingerprint takes a signal
        // configuration and returns a hash; there is no parameter through which
        // an asset could enter it, so every asset shares one version by
        // construction rather than by accident.
        const left = fingerprintStrategy();
        const right = fingerprintStrategy();

        expect(right.hash).toBe(left.hash);
        expect(Object.keys(left.config)).not.toContain('symbol');
        expect(Object.keys(left.config)).not.toContain('asset');
        expect(Object.keys(left.config)).not.toContain('instrument');
    });

    it('counts every asset together when nobody says which asset', async () => {
        // The title of this test used to say the reader "offers no way to ask for
        // one", and that was true. It stopped being true in round 106, when the
        // reader gained an optional market — and a test whose name is no longer
        // what it asserts is worse than no test, because it is checked and
        // believed. What a version still *is* has not changed: it has no market,
        // so an unscoped read blends, and this is the assertion that keeps the
        // structural fact visible rather than quietly fixed by the gate.
        const version = await aVersion();
        const btc = await aSignal('BTCUSDT', version);
        const eth = await aSignal('ETHUSDT', version);

        await measured('BTCUSDT', btc, version, 'correct');
        await measured('ETHUSDT', eth, version, 'incorrect');

        const evidence = await reader.evidenceFor(version, 72, null);

        // Two assets, one number. BTC was right and ETH was wrong, and the
        // reader cannot tell you which was which, because it was never asked.
        expect(evidence.signals).toBe(2);
        expect(evidence.resolved).toBe(2);
        expect(evidence.correct).toBe(1);
        expect(evidence.incorrect).toBe(1);
    });

    it('is a blend no single asset produced', async () => {
        const version = await aVersion();

        for (const series of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
            const state = await aSignal(series, version);
            await measured(series, state, version, 'correct');
        }

        const evidence = await reader.evidenceFor(version, 72, null);

        // 100% — a number that is true of all three assets and of no market.
        // It answers a question the system cannot otherwise pose: how did this
        // rule do, across everything it ran on.
        expect(evidence.correct).toBe(evidence.resolved);
        expect(evidence.resolved).toBe(3);
    });

    it('can be asked about one asset, which is what the promotion gate now does', async () => {
        // **The half that needed no owner decision.** Splitting `strategy_version`
        // per market is a migration and a decision, and it is still open — see the
        // header of this file. But counting another market's results toward a
        // promotion never needed either. The gate asks about its own market now,
        // so a candidate that was right on BTC and wrong on ETH is judged on the
        // market it is being approved for.
        //
        // Same version, same rows, two questions — and the answers are the ones
        // each market actually produced.
        const version = await aVersion();
        const btc = await aSignal('BTCUSDT', version);
        const eth = await aSignal('ETHUSDT', version);

        await measured('BTCUSDT', btc, version, 'correct');
        await measured('ETHUSDT', eth, version, 'incorrect');

        const onBtc = await reader.evidenceFor(version, 72, null, 'BTCUSDT');
        const onEth = await reader.evidenceFor(version, 72, null, 'ETHUSDT');

        expect(onBtc.signals).toBe(1);
        expect(onBtc.resolved).toBe(1);
        expect(onBtc.correct).toBe(1);
        expect(onBtc.incorrect).toBe(0);

        expect(onEth.signals).toBe(1);
        expect(onEth.resolved).toBe(1);
        expect(onEth.correct).toBe(0);
        expect(onEth.incorrect).toBe(1);
    });

    it('reports an empty market as empty, not as the blend', async () => {
        // A market that traded nothing under this version has no evidence, and
        // must read as zero rather than as everything else. Otherwise a rule could
        // be approved for a market on another market's record — which is the
        // finding, and would still be reachable through this path.
        const version = await aVersion();
        const btc = await aSignal('BTCUSDT', version);

        await measured('BTCUSDT', btc, version, 'correct');

        const nowhere = await reader.evidenceFor(version, 72, null, 'SOLUSDT');

        expect(nowhere.signals).toBe(0);
        expect(nowhere.resolved).toBe(0);
        expect(nowhere.correct).toBe(0);
    });

    it('compares the incumbent on the same market, not across all of them', async () => {
        // The market has to reach the incumbent tally too. Filtering only the
        // candidate would compare one market's candidate against every market's
        // incumbent — a blend in both halves rather than one, and a subtler bug
        // than the one it replaced, because the candidate side would look correct.
        //
        // The incumbent's signal is on ETHUSDT rather than BTCUSDT because
        // `signal_state` allows one live signal per (symbol, provider, interval),
        // so this is the arrangement that can exist. Before the fix the incumbent
        // tally ignored the market entirely and would have reported 1 here, which
        // is the number this test exists to pin at 0.
        const version = await aVersion();
        const incumbent = await aVersion();

        await measured('BTCUSDT', await aSignal('BTCUSDT', version), version, 'correct');
        await measured('ETHUSDT', await aSignal('ETHUSDT', incumbent), incumbent, 'incorrect');

        const evidence = await reader.evidenceFor(version, 72, incumbent, 'BTCUSDT');

        expect(evidence.correct).toBe(1);
        expect(evidence.incumbentCorrect).toBe(0);
        expect(evidence.incumbentResolved).toBe(0);
    });
});
