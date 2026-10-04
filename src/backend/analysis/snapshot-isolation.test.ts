import { beforeEach, describe, expect, it } from 'vitest';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';
import { createSignalSnapshotRepository } from './signal-snapshot.repository.js';

import type { StrategyVersion } from './strategy-version.repository.js';

/**
 * What makes a snapshot a new row rather than a duplicate.
 *
 * **There are two different guards here, and I had them the wrong way round.**
 * The first version of this file's header said the `input_hash` keeps two assets
 * apart, and the negative control proved it does not: dropping `symbol` from the
 * hash left all six tests green. What actually separates two assets is the
 * `ON CONFLICT (symbol, input_hash)` target — the column is in the unique
 * index, so two assets can carry the same hash and still be two rows.
 *
 * What the hash *does* carry, and what the controls confirm it guards, is the
 * **venue**, the **interval** and the **strategy version**: those are not in
 * any index, so a row would collapse unless the hash says they changed. The
 * provider is the one with a measured cost behind it — `second-source.ts` found
 * the two venues moving the numbers by +5.74% against +0.45% on one identical
 * rule, and a row attributed to the wrong venue is undetectable afterwards,
 * because nothing in it says which venue wrote it.
 *
 * So: two assets are kept apart by the schema, and two measurements of one asset
 * are kept apart by the hash. Writing a test that passes when the second guard is
 * removed is worse than writing no test, because it reports the first as
 * protected.
 */

const NOW = 1_760_000_000_000;

/**
 * A real `strategy_version` row, because the foreign key is not decoration.
 *
 * The first version of this file invented `{ id: 1 }` and every insert failed
 * on `signal_snapshot_strategy_version_id_fkey`. That is the constraint working:
 * a snapshot attributed to a configuration that does not exist is exactly the
 * dangling reference the promotion chain is built to prevent, so the version is
 * created rather than assumed.
 */
async function versionRow(name: string): Promise<StrategyVersion> {
    const { rows } = await getTestPool().query<StrategyVersion>(
        `INSERT INTO strategy_version (created_at, name, description, config, config_hash)
         VALUES ($1, $2, '', '{}'::jsonb, $3)
         RETURNING id, name, config_hash, created_at`,
        [NOW, name, `${name}-${Math.random()}`],
    );

    return rows[0]!;
}

function bar(offset: number) {
    const close = 100 + offset;

    return {
        timestamp: NOW + offset * 3_600_000,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000 + offset,
    };
}

/** The same bars for both assets. A venue can serve identical numbers twice. */
const CANDLES = [bar(0), bar(1), bar(2)];

const snapshotFor = (
    symbol: string,
    strategyVersion: StrategyVersion,
    provider = 'binance',
    interval = '1h',
) => ({
    symbol,
    strategyVersion,
    snapshot: { symbol, direction: 'LONG', confidence: 0.6 },
    candles: CANDLES,
    price: 100,
    provider,
    interval,
});

const repository = createSignalSnapshotRepository();

describe('a snapshot is filed under the asset it measured', () => {
    let version: StrategyVersion;
    let other: StrategyVersion;

    beforeEach(async () => {
        await truncateSignalTables();

        version = await versionRow('v');
        other = await versionRow('w');
    });

    it('keeps two assets apart even when their bars are identical', async () => {
        // Two rows, because the unique index is on `(symbol, input_hash)` and
        // not on the hash alone. This is the M9 class — data mixed between
        // assets does not look broken — and it is protected by the schema.
        //
        // Read this next to the file header: removing `symbol` from the hash
        // does **not** break this test, and that is correct. The hash's job is
        // elsewhere.
        const first = await repository.record(snapshotFor('BTCUSDT', version));
        const second = await repository.record(snapshotFor('ETHUSDT', version));

        expect(first.created).toBe(true);
        expect(second.created).toBe(true);
        expect(second.id).not.toBe(first.id);
    });

    it('keeps the same asset from being written twice', async () => {
        // The other half, and the reason the key exists at all. Every successful
        // analysis writes a snapshot, so without this an hour of page loads
        // would produce a history that says the market was read N times. This is
        // the half the hash really is responsible for.
        const first = await repository.record(snapshotFor('BTCUSDT', version));
        const again = await repository.record(snapshotFor('BTCUSDT', version));

        expect(again.created).toBe(false);
        expect(again.id).toBe(first.id);
    });

    it('keeps two venues apart, because the same bars can differ', async () => {
        // Second source moved the numbers by +5.74% against +0.45% on one
        // identical rule. A row attributed to the wrong venue cannot be
        // detected afterwards, because nothing in it says which venue wrote it.
        //
        // Unlike the asset test above, this one has teeth on the hash: removing
        // `provider` from `inputFingerprint` fails exactly this test.
        const first = await repository.record(snapshotFor('BTCUSDT', version, 'binance'));
        const second = await repository.record(snapshotFor('BTCUSDT', version, 'kraken'));

        expect(second.created).toBe(true);
        expect(second.id).not.toBe(first.id);
    });

    it('keeps two timeframes apart, because a daily bar is not an hourly one', async () => {
        const first = await repository.record(snapshotFor('BTCUSDT', version, 'binance', '1h'));
        const second = await repository.record(snapshotFor('BTCUSDT', version, 'binance', '1d'));

        expect(second.created).toBe(true);
        expect(second.id).not.toBe(first.id);
    });

    it('does not let a different strategy version borrow the row', async () => {
        // The same bars measured under a different rule are a different claim,
        // and reusing the row would file a signal under a configuration it was
        // not produced by.
        const first = await repository.record(snapshotFor('BTCUSDT', version));
        const second = await repository.record(snapshotFor('BTCUSDT', other));

        expect(second.created).toBe(true);
        expect(second.id).not.toBe(first.id);
    });

    it('leaves each row carrying the asset it was written for', async () => {
        // Not just "two rows" but "two rows, correctly labelled". A key that
        // distinguished them while a column mislabelled them would pass every
        // assertion above and still be wrong.
        await repository.record(snapshotFor('BTCUSDT', version));
        await repository.record(snapshotFor('ETHUSDT', version));

        const { rows } = await getTestPool().query<{ symbol: string; count: string }>(
            `SELECT symbol, COUNT(*)::text AS count
               FROM signal_snapshot
              GROUP BY symbol
              ORDER BY symbol`,
        );

        expect(rows).toEqual([
            { symbol: 'BTCUSDT', count: '1' },
            { symbol: 'ETHUSDT', count: '1' },
        ]);
    });
});
