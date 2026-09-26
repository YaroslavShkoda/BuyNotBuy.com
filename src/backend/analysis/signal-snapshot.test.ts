import { beforeEach, describe, expect, it } from 'vitest';

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
import { query } from '../db/pool.js';

import type { Candle } from '../types/market.js';

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
        const version = await createStrategyVersionRepository().resolveActive();
        const repository = createSignalSnapshotRepository();

        const { id, created } = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
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

    it('stores the same inputs once, however many times it is called', async () => {
        const version = await createStrategyVersionRepository().resolveActive();
        const repository = createSignalSnapshotRepository();

        const first = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
            snapshot,
        });

        const second = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
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
        const version = await createStrategyVersionRepository().resolveActive();
        const repository = createSignalSnapshotRepository();

        const first = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
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
            snapshot,
        });

        expect(revised.id).not.toBe(first.id);
    });

    it('distinguishes revised candle contents from unchanged ones', async () => {
        const version = await createStrategyVersionRepository().resolveActive();
        const repository = createSignalSnapshotRepository();

        const first = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
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
            snapshot,
        });

        expect(second.id).not.toBe(first.id);
    });

    it('keeps the same candles apart under a different strategy version', async () => {
        const versions = createStrategyVersionRepository();
        const repository = createSignalSnapshotRepository();

        const first = await versions.resolveActive();

        // A real second version. A fabricated id would have been simpler and
        // would have failed on the foreign key instead — which is the
        // guarantee below, tested properly further down.
        const created = await query<{ id: number }>(
            `INSERT INTO strategy_version
                 (created_at, name, description, config, config_hash, status)
             VALUES ($1, 'other', 'A different configuration.', '{}'::jsonb, $2, 'draft')
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
            snapshot,
        });

        const two = await repository.record({
            symbol: 'BTCUSDT',
            strategyVersion: second ?? first,
            price: 104,
            candles: candles(5),
            snapshot,
        });

        // Identical market, different strategy: two different decisions, and
        // later statistics must be able to tell them apart.
        expect(two.id).not.toBe(one.id);
    });

    it('refuses to delete a strategy version a snapshot depends on', async () => {
        const version = await createStrategyVersionRepository().resolveActive();

        await createSignalSnapshotRepository().record({
            symbol: 'BTCUSDT',
            strategyVersion: version,
            price: 104,
            candles: candles(5),
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
        const version = await createStrategyVersionRepository().resolveActive();
        const repository = createSignalSnapshotRepository();

        for (const price of [100, 101, 102]) {
            await repository.record({
                symbol: 'BTCUSDT',
                strategyVersion: version,
                price,
                candles: candles(5, price),
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
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1);
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 1);

        expect(first.inputHash).toBe(second.inputHash);
    });

    it('changes when the symbol changes', () => {
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1);
        const second = inputFingerprint('ETHUSDT', 100, candles(3), 1);

        expect(first.inputHash).not.toBe(second.inputHash);
    });

    it('changes when the strategy changes', () => {
        const first = inputFingerprint('BTCUSDT', 100, candles(3), 1);
        const second = inputFingerprint('BTCUSDT', 100, candles(3), 2);

        expect(first.inputHash).not.toBe(second.inputHash);
    });
});

describe('strategy version', () => {
    it('reuses the version for a configuration it has already seen', async () => {
        const repository = createStrategyVersionRepository();

        const first = await repository.resolveActive();
        const second = await repository.resolveActive();

        // A second version describing identical settings would leave a
        // snapshot stored under one of them claiming provenance the other
        // claims too, with no way to tell them apart later.
        expect(second.id).toBe(first.id);
    });

    it('starts as a draft, because nothing has approved it', async () => {
        const version = await createStrategyVersionRepository().resolveActive();

        expect(version.status).toBe('draft');
    });

    it('shares one repository through the accessor', () => {
        expect(getStrategyVersionRepository()).toBe(
            getStrategyVersionRepository(),
        );
    });

    it('names the configuration it describes', async () => {
        const version = await createStrategyVersionRepository().resolveActive();

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
