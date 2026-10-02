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
 * **This test does not change it.** Splitting the version per asset is a
 * decision with a migration behind it — every stored `strategy_version`,
 * `signal_state`, `signal_snapshot` and `signal_outcome` would have to be
 * re-attributed, and old results are never rewritten. What the test does is put
 * the blend where it can be seen, with the number, instead of leaving it to be
 * discovered later as a win rate nobody can reproduce on any single asset.
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

    it('counts every asset together, and offers no way to ask for one', async () => {
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
});
