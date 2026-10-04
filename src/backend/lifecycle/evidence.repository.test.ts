import { beforeEach, describe, expect, it } from 'vitest';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';
import { createEvidenceReader } from './evidence.repository.js';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

describe('what a rule has actually done', () => {
    const pool = getTestPool();
    const reader = createEvidenceReader();

    const aVersion = async (name: string): Promise<number> => {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO strategy_version (created_at, name, description, config, config_hash)
             VALUES ($1, $2, '', '{}'::jsonb, $3) RETURNING id`,
            [NOW, name, `${name}-${Math.random()}`],
        );

        return Number(rows[0]?.id);
    };

    /**
     * One signal published from a snapshot under `versionId`, and nothing
     * measured about it yet.
     *
     * `signal_state` is unique on (symbol, provider, interval) — one live
     * signal per series, which is the table's whole point — so every test
     * signal gets its own market instead of fighting that index.
     */
    const aSignal = async (series: string, versionId: number): Promise<string> => {
        const snap = await pool.query<{ id: string }>(
            `INSERT INTO signal_snapshot
                 (symbol, provider, interval, strategy_version_id, input_hash,
                  snapshot, first_candle_ts, last_candle_ts, candle_count,
                  candles_hash, created_at)
             VALUES ($1, 'binance', '1h', $2, $3, '{}'::jsonb, $4, $4, 1, 'c', $4)
             RETURNING id`,
            [series, versionId, `snap-${series}`, NOW],
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

    /** One judgement of that signal at one distance. */
    const measured = async (
        series: string,
        stateId: string,
        versionId: number,
        verdict: string,
        horizon: number,
    ): Promise<void> => {
        await pool.query(
            `INSERT INTO signal_outcome
                 (symbol, provider, interval, signal_state_id, direction, verdict,
                  horizon_bars, entry_timestamp, entry_price, closed_by,
                  strategy_version_id, created_at, updated_at)
             VALUES ($1, 'binance', '1h', $2, 'LONG', $3, $4, $5, 100,
                     'expired', $6, $5, $5)`,
            [series, stateId, verdict, horizon, NOW, versionId],
        );
    };

    let version = 0;
    let other = 0;

    beforeEach(async () => {
        await truncateSignalTables();
        // CASCADE because `signal_snapshot` and `signal_outcome` both carry a
        // foreign key to `strategy_version`, and PostgreSQL refuses to empty a
        // table something else points at. Safe here and only here: every test
        // file runs against its own schema.
        await pool.query(
            'TRUNCATE signal_state, signal_snapshot, signal_outcome, strategy_version CASCADE',
        );
        version = await aVersion('candidate');
        other = await aVersion('incumbent');
    });

    it('counts a signal once, however many horizons it was measured at', async () => {
        // **The trap this module exists to avoid.** One signal measured at seven
        // horizons leaves seven rows. Summing them counts one signal seven
        // times, lets a rule clear a twenty-sample gate on three signals, and
        // reports nothing wrong at any step: every row is real and every count
        // is true. Only the evidence is smaller than it looks.
        const stateId = await aSignal('SYM-A', version);

        for (const horizon of [1, 3, 6, 12, 24, 48, 72]) {
            await measured('SYM-A', stateId, version, 'correct', horizon);
        }

        const evidence = await reader.evidenceFor(version, 6, null);

        expect(evidence.signals).toBe(1);
        expect(evidence.resolved).toBe(1);
        expect(evidence.correct).toBe(1);
    });

    it('judges only at the horizon it was asked about', async () => {
        // A signal can be right at six bars and wrong at seventy-two. Reading
        // every horizon at once would let a rule pick the distance that flatters
        // it, which is the same as having no rule at all.
        const stateId = await aSignal('SYM-B', version);

        await measured('SYM-B', stateId, version, 'correct', 6);
        await measured('SYM-B', stateId, version, 'incorrect', 72);

        const atSix = await reader.evidenceFor(version, 6, null);
        const atSeventyTwo = await reader.evidenceFor(version, 72, null);

        expect(atSix.correct).toBe(1);
        expect(atSix.incorrect).toBe(0);
        expect(atSeventyTwo.correct).toBe(0);
        expect(atSeventyTwo.incorrect).toBe(1);
    });

    it('counts a signal that has no measurement yet, because it was still produced', async () => {
        // Reading signals out of `signal_outcome` instead of `signal_state`
        // silently drops the ones whose horizon has not closed. That makes
        // "wait for more signals" report that enough have already arrived, and
        // turns a rule that needs time into a rule that has had it.
        await aSignal('SYM-C', version);

        const evidence = await reader.evidenceFor(version, 6, null);

        expect(evidence.signals).toBe(1);
        expect(evidence.resolved).toBe(0);
    });

    it('does not count an unresolved verdict as an answer', async () => {
        const ranOut = await aSignal('SYM-D', version);
        const answered = await aSignal('SYM-E', version);

        await measured('SYM-D', ranOut, version, 'expired', 6);
        await measured('SYM-E', answered, version, 'correct', 6);

        const evidence = await reader.evidenceFor(version, 6, null);

        // 'expired' is a signal that ran out of time, not one that was wrong.
        // Counting it as a measurement would make a rule that rarely lets a
        // signal resolve look like one that is often wrong.
        expect(evidence.signals).toBe(2);
        expect(evidence.resolved).toBe(1);
        expect(evidence.incorrect).toBe(0);
    });

    it('compares against the incumbent and not against itself', async () => {
        const mine = await aSignal('SYM-F', version);
        const second = await aSignal('SYM-G', version);
        const theirs = await aSignal('SYM-H', other);

        await measured('SYM-F', mine, version, 'correct', 6);
        await measured('SYM-G', second, version, 'incorrect', 6);
        await measured('SYM-H', theirs, other, 'correct', 6);

        const evidence = await reader.evidenceFor(version, 6, other);

        expect(evidence.resolved).toBe(2);
        expect(evidence.correct).toBe(1);
        // Three rows exist; one of them is the incumbent's.
        expect(evidence.incumbentResolved).toBe(1);
        expect(evidence.incumbentCorrect).toBe(1);
    });

    it('reports a rule that has never run as having no evidence and no history', async () => {
        // `firstSeenAt` of zero would be the worst kind of lie here: the gate
        // reads `now - firstSeenAt` as an age, so a rule with no history would
        // appear to have sat in shadow for fifty years and sail past the window
        // on the strength of having measured nothing.
        const evidence = await reader.evidenceFor(other, 6, null);

        expect(evidence.signals).toBe(0);
        expect(evidence.resolved).toBe(0);
        expect(evidence.firstSeenAt).toBeGreaterThan(0);
        expect(Date.now() - evidence.firstSeenAt).toBeLessThan(DAY);
    });
});
