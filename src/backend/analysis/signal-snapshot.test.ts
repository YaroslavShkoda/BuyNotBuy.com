import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../db/pool.js';
import type { Candle } from '../types/market.js';
import {
    createSignalSnapshotRepository,
    getSignalSnapshotRepository,
    inputFingerprint,
    resetSignalSnapshotRepository,
} from './signal-snapshot.repository.js';import {
    createStrategyVersionRepository,
    getStrategyVersionRepository,
    resetStrategyVersionRepository,
} from './strategy-version.repository.js';

const HOUR = 1_700_000_000_000;

function candles(count: number, base = 100): Candle[] {
    return Array.from({ length: count }, (_unused, index) => ({
        timestamp: HOUR + index * 3_600_000,
        open: base + index,
        high: base + index + 1,
        low: base + index - 1,
        close: base + index,
        volume: 10,
    }));
}

const snapshot = { signal: { signal: 'LONG', confidence: 61 } };

beforeEach(async () => {
    resetSignalSnapshotRepository();
    resetStrategyVersionRepository();

    // The setup file truncates the two service tables; these two are new and
    // nothing else in the suite writes to them.
    await query('TRUNCATE signal_snapshot, strategy_version RESTART IDENTITY CASCADE');
});

describe('signal snapshot', () => {
    it('stores a snapshot and reads it back unchanged', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');
        const repository = createSignalSnapshotRepository();

        const { id, created } = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        expect(created).toBe(true);

        const read = await repository.byId(id);

        expect(read?.snapshot).toEqual(snapshot);
        expect(read?.symbol).toBe('BTCUSDT');
        expect(read?.candleCount).toBe(5);
        expect(read?.firstCandleTs).toBe(HOUR);
        expect(read?.lastCandleTs).toBe(HOUR + 4 * 3_600_000);
    });

    it('keeps a snapshot from a second venue instead of calling it a duplicate', async () => {
        // The defect, seen from outside. Byte-identical candles from two venues
        // used to produce the same input hash, the unique index on
        // `(symbol, input_hash)` matched, and `ON CONFLICT DO NOTHING` returned
        // the *first* row with `created: false` — so the second venue was not
        // refused, it was silently folded into the first, and nothing anywhere
        // said which venue had actually been measured.
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');
        const repository = createSignalSnapshotRepository();

        const fromBinance = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        const fromBybit = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            // The very same candles. Nothing is wrong with bybit; that is the
            // point — the two venues agreeing is not a reason to keep one.
            candles: candles(5),
            provider: 'bybit',
            interval: '1h',
            snapshot,
        });

        expect(fromBinance.created).toBe(true);
        expect(fromBybit.created).toBe(true);
        expect(fromBybit.id).not.toBe(fromBinance.id);

        const stored = await repository.byId(fromBybit.id);
        expect(stored?.provider).toBe('bybit');
    });

    it('reads back which venue a snapshot came from', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');
        const repository = createSignalSnapshotRepository();

        const { id } = await repository.record({
            symbol: 'ETHUSDT',
            strategyVersion: version,
            price: 3000,
            candles: candles(5, 3000),
            provider: 'okx',
            interval: '4h',
            snapshot,
        });

        const read = await repository.byId(id);

        expect(read?.provider).toBe('okx');
        expect(read?.interval).toBe('4h');
    });

    it('stores the same inputs once, however many times it is called', async () => {
        const version = await createStrategyVersionRepository().resolveActive('ETHUSDT');
        const repository = createSignalSnapshotRepository();

        const first = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        const second = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        // The analysis runs on every page load. Without this, a dashboard left
        // open overnight fills the table with byte-identical rows, and the
        // count of snapshots stops meaning "how many decisions" and starts
        // meaning "how many people looked".
        expect(second.id).toBe(first.id);
        expect(second.created).toBe(false);

        const all = await query<{ total: number }>(
            'SELECT COUNT(*)::int AS total FROM signal_snapshot',
        );

        expect(all.rows[0]?.total).toBe(1);
    });

    it('distinguishes a revised price from an unchanged one', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');
        const repository = createSignalSnapshotRepository();

        const first = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        // Same candles, different last price: the provider revised the newest
        // close. That is a different market, and a snapshot that did not
        // notice would claim to be derived from prices the database never saw.
        const revised = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 105,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        expect(revised.id).not.toBe(first.id);
    });

    it('distinguishes revised candle contents from unchanged ones', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');
        const repository = createSignalSnapshotRepository();

        const first = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        const edited = candles(5);
        const last = edited[edited.length - 1];

        if (last !== undefined) {
            last.close = 999;
        }

        const second = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: edited,
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        expect(second.id).not.toBe(first.id);
    });

    it('keeps the same candles apart under a different strategy version', async () => {
        const versions = createStrategyVersionRepository();
        const repository = createSignalSnapshotRepository();

        const first = await versions.resolveActive('BTCUSDT');

        // A real second version. A fabricated id would have been simpler and
        // would have failed on the foreign key instead — which is the
        // guarantee below, tested properly further down.
        const created = await query<{ id: number }>(
            `INSERT INTO strategy_version
                 (created_at, name, description, config, config_hash)
             VALUES ($1, 'other', 'A different configuration.', '{}'::jsonb, $2)
             RETURNING id`,
            [Date.now(), 'a-different-configuration'],
        );

        const second = await versions.byId(created.rows[0]?.id ?? 0);

        expect(second).not.toBeNull();

        const one = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: first,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        const two = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: second ?? first,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        // Identical market, different strategy: two different decisions, and
        // later statistics must be able to tell them apart.
        expect(two.id).not.toBe(one.id);
    });

    it('refuses to delete a strategy version a snapshot depends on', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');

        await createSignalSnapshotRepository().record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            provider: 'binance',
            interval: '1h',
            snapshot,
        });

        // `ON DELETE RESTRICT`, not `CASCADE`: retiring a version must not
        // take the evidence collected under it. Every walk-forward and shadow
        // number in the system is measured against these rows, and a cascade
        // would leave the numbers standing with nothing to check them against.
        //
        // Matched on the SQLSTATE rather than the message, because the
        // server's locale here is Russian and a test asserting the English
        // text of a translated error passes on one machine and fails on
        // another. 23001 is `restrict_violation` — specifically what `RESTRICT`
        // raises, as distinct from 23503 (`foreign_key_violation`), which a
        // plain `NO ACTION` constraint would also produce. Asserting 23001 is
        // what makes this a test of `RESTRICT` rather than of the existence of
        // a foreign key.
        let code: string | undefined;

        try {
            await query('DELETE FROM strategy_version WHERE id = $1', [version.id]);
        } catch (error) {
            code = (error as { code?: string }).code;
        }

        expect(code).toBe('23001');

        const still = await createStrategyVersionRepository().byId(version.id);

        expect(still).not.toBeNull();
    });

    it('returns snapshots newest first', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');
        const repository = createSignalSnapshotRepository();

        for (const price of [100, 101, 102]) {
            await repository.record({
                symbol: 'BTCUSDT',
                strategyVersion: version,
                price,
                candles: candles(5, price),
                provider: 'binance',
            interval: '1h',
            snapshot,
            });
        }

        const listed = await repository.list('BTCUSDT', 10);

        expect(listed).toHaveLength(3);
        expect(listed[0]?.id).toBeGreaterThan(listed[1]?.id ?? 0);
    });

    it('returns nothing for an unknown id rather than throwing', async () => {
        expect(await createSignalSnapshotRepository().byId(999_999)).toBeNull();
    });
});

describe('input fingerprint', () => {
    it('is stable for the same inputs', () => {
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');

        expect(first.inputHash).toBe(second.inputHash);
    });

    it('changes when the symbol changes', () => {
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');
        const second = inputFingerprint('ETHUSDT', 100, candles(3), 1, 'binance', '1h');

        expect(first.inputHash).not.toBe(second.inputHash);
    });

    it('changes when the strategy changes', () => {
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 2, 'binance', '1h');

        expect(first.inputHash).not.toBe(second.inputHash);
    });

    it('changes when only the venue changes', () => {
        // **The defect this pins.** The fingerprint was
        // `{symbol, price, strategyVersionId, candlesHash}` — byte-identical
        // candles from two venues hashed the same, the unique index on
        // `(symbol, input_hash)` matched, `ON CONFLICT DO NOTHING` dropped the
        // second snapshot, and the row that survived was attributed to whichever
        // venue arrived first with nothing on it saying which. That is
        // invariant 9, and `second-source.ts` is the reason it is not cosmetic:
        // the provider moved the numbers by +5.74% against +0.45% on one rule.
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'bybit', '1h');

        expect(first.inputHash).not.toBe(second.inputHash);
    });

    it('changes when only the timeframe changes', () => {
        // Same series of bars, different question asked of it. Without this the
        // two would be one record.
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1d');

        expect(first.inputHash).not.toBe(second.inputHash);
    });

    it('is unchanged by the venue when nothing else moves', () => {
        // The negative control, and the reason the change is safe: the same
        // venue re-reporting the same market must still be one record, or every
        // page load would write a new row and the idempotence this fingerprint
        // exists for would be gone.
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 1, 'binance', '1h');

        expect(second.inputHash).toBe(first.inputHash);
    });
});

describe('strategy version', () => {
    it('reuses the version for a configuration it has already seen', async () => {
        const repository = createStrategyVersionRepository();

        const first = await repository.resolveActive('BTCUSDT');
        const second = await repository.resolveActive('BTCUSDT');

        // A second version describing identical settings would leave a
        // snapshot stored under one of them claiming provenance the other
        // claims too, with no way to tell them apart later.
        expect(second.id).toBe(first.id);
    });

    it('cannot be marked approved, because the column that held the word is gone', async () => {
        // The test this replaces asserted `version.status === 'draft'` — a
        // version starts as a draft because nothing has approved it. It read as
        // a governance rule and enforced nothing: the CHECK accepted
        // 'approved' as readily, no code path ever wrote it, and no code path
        // ever read it. `resolveActive` selects by config_hash alone, so a
        // version's status could not have decided anything even in principle.
        //
        // What is worth asserting now is the schema itself, because that is
        // where the claim used to live. Against the old column this fails on the
        // first query; it is a test about the database, not about the
        // repository's return value.
        //
        // `current_schema()`, not `public`. This file's tests run in their own
        // schema, applied by the setup file, and naming `public` asked the real
        // database a question about the developer's production schema instead:
        // the assertion then passed or failed according to how far that database
        // had been migrated, and nothing about the code under test. CI builds a
        // fresh database every run, so it agreed there by accident and failed on
        // a workstation whose `public` had not been migrated past version 16.
        // Every other query in this file goes through the connection's own
        // `search_path`; this one opted out of the isolation the harness built.
        const columns = await query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'strategy_version'`,
        );

        const names = columns.rows.map((row) => row.column_name);

        // The table has to have been found, or the assertion below is satisfied
        // by an empty array and the test measures nothing. `config_hash` is here
        // because it is what identifies a version, and it was never optional in
        // any migration: its absence would mean the schema under test is not the
        // one this code creates.
        expect(names).toContain('config_hash');

        expect(names).not.toContain('status');
    });

    it('still resolves a version by the configuration it describes', async () => {
        // The part that must not have been lost with the column. A version is
        // identified by its hash and nothing else; removing a status that never
        // participated must leave that exactly as it was.
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');

        expect(version.configHash).toMatch(/^[0-9a-f]+$/);
        expect(version.id).toBeGreaterThan(0);
    });

    it('shares one repository through the accessor', () => {
        expect(getStrategyVersionRepository()).toBe(
            getStrategyVersionRepository(),
        );
    });

    it('names the configuration it describes', async () => {
        const version = await createStrategyVersionRepository().resolveActive('BTCUSDT');

        const row = await query<{ config: unknown }>(
            'SELECT config FROM strategy_version WHERE id = $1',
            [version.id],
        );

        expect(row.rows[0]?.config).toMatchObject({
            periods: { ema: 300 },
        });
    });

    it('shares one repository through the accessor', () => {
        expect(getSignalSnapshotRepository()).toBe(getSignalSnapshotRepository());
    });
});
