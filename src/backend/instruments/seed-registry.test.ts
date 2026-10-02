import { beforeEach, describe, expect, it } from 'vitest';

import { AssetRepository } from './asset.repository.js';
import { query } from '../db/pool.js';
import { seedConfiguredRegistry } from './seed-registry.js';

import type { Asset } from './domain.js';

/**
 * The property that was false on every live deployment, stated so it can fail.
 *
 * The registry route reads the `instrument` table. For as long as the service
 * had been running, nothing in production wrote that table — `recordInstrument`
 * was called from `asset.repository.test.ts` and `instruments.test.ts` and from
 * nowhere else — so `GET /api/instruments` returned `[]` on a database whose
 * `asset` table held eight rows. The asset list being correct is what hid it: an
 * empty instrument list beside a populated asset list reads as a configuration
 * with no instruments, which is an ordinary thing, rather than as a write path
 * that does not exist.
 *
 * Nothing caught it because the existing check for this class,
 * `stranded-modules.test.ts`, works at module granularity. `asset.repository.ts`
 * *was* reachable — `server.ts` imported `getAssetRepository` — and a reachable
 * module holding an unreachable method looks exactly like a reachable module.
 *
 * So the assertions below are behavioural rather than structural: seed the way the
 * server does, then ask the repository what the route asks. Drop the instrument
 * from the startup path and this fails on the number the route would return, not
 * on a source pattern.
 */

const repository = new AssetRepository();

const BTC: Asset = {
    symbol: 'BTC',
    name: 'Bitcoin',
    category: 'crypto',
    status: 'active',
};

const USDT: Asset = {
    symbol: 'USDT',
    name: 'Tether',
    category: 'crypto',
    status: 'active',
};

const CONFIGURED = [BTC, USDT];

describe('the registry the service writes at start', () => {
    beforeEach(async () => {
        await query('DELETE FROM instrument');
        await query('DELETE FROM asset');
    });

    it('can answer the instruments route afterwards', async () => {
        expect(await repository.listInstruments()).toEqual([]);

        const seeded = await seedConfiguredRegistry(repository, CONFIGURED, 'BTCUSDT');

        expect(seeded.assetsInserted).toBe(2);
        expect(seeded.instrument).toBe('BTCUSDT');
        expect(seeded.instrumentInserted).toBe(true);

        // Exactly what `instruments.controller.ts` asks for.
        const instruments = await repository.listInstruments();

        expect(instruments.map((row) => row.ticker)).toEqual(['BTCUSDT']);
    });

    it('writes the halves of the pair, because an instrument without them is not answerable', async () => {
        await seedConfiguredRegistry(repository, [BTC], 'BTCUSDT');

        const assets = await repository.listAssets();
        const symbols = assets.map((row) => row.symbol);

        expect(symbols).toContain('BTC');
        expect(symbols).toContain('USDT');

        const btc = assets.find((row) => row.symbol === 'BTC');

        // The configured category survives the later instrument write, which is
        // what the `ON CONFLICT DO NOTHING` in both places is for.
        expect(btc?.category).toBe('crypto');
        expect(btc?.source).toBe('configured');

        // The quote half was not declared in configuration, so `recordInstrument`
        // wrote it. Its category comes from the registry — which knows USDT as
        // crypto — and what marks it as undeclared is the status and the source,
        // not a third category the type does not have.
        const usdt = assets.find((row) => row.symbol === 'USDT');

        expect(usdt?.status).toBe('unknown');
        expect(usdt?.source).toBe('learned');
        expect(usdt?.category).toBe('crypto');
    });

    it('is safe on every start after the first', async () => {
        await seedConfiguredRegistry(repository, CONFIGURED, 'BTCUSDT');

        const second = await seedConfiguredRegistry(repository, CONFIGURED, 'BTCUSDT');

        expect(second.assetsInserted).toBe(0);
        expect(second.instrumentInserted).toBe(false);

        // One pair, one row: a start loop that inserted a duplicate lands here.
        expect(await repository.listInstruments()).toHaveLength(1);
    });
});

describe('a process that observes two markets', () => {
    const ETH: Asset = {
        symbol: 'ETH',
        name: 'Ethereum',
        category: 'crypto',
        status: 'active',
    };

    beforeEach(async () => {
        await query('DELETE FROM instrument');
        await query('DELETE FROM asset');
    });

    it('writes both instruments, not only the one it was named', async () => {
        // **This is the item.** The seed recorded the single ticker its caller
        // passed, so a process observing two markets wrote rows for one of them.
        // The other had no `instrument` row — which means `judgeTradability`
        // answers `unknown_instrument` for it, `GET /api/instruments` leaves it out
        // (the controller refuses to invent a classification for an instrument whose
        // halves are missing), and its `asset` rows land with `status: 'unknown'`.
        //
        // None of that is corruption. All of it is a registry saying the system does
        // not trade a market it publishes signals for every minute.
        const seeded = await seedConfiguredRegistry(
            repository,
            [...CONFIGURED, ETH],
            'BTCUSDT',
            ['BTCUSDT', 'ETHUSDT'],
        );

        // Exactly what the route asks for, and the answer is both.
        const instruments = await repository.listInstruments();

        expect(instruments.map((row) => row.ticker).sort()).toEqual([
            'BTCUSDT',
            'ETHUSDT',
        ]);

        expect(seeded.instruments).toEqual([
            { ticker: 'BTCUSDT', inserted: true },
            { ticker: 'ETHUSDT', inserted: true },
        ]);
    });

    it('reports the second market tradable rather than unknown', async () => {
        // **The control comes first, or this test proves nothing.** A market nobody
        // wrote down is refused, and that refusal is the whole defect: an observed
        // market that the registry says it does not trade. Without the control, a
        // `tradable` assertion could be satisfied by a repository that answers
        // `true` to everything.
        const beforeSeed = await repository.tradability('ETHUSDT');

        expect(beforeSeed.tradable).toBe(false);
        expect(beforeSeed.tradable === false && beforeSeed.reason).toBe('unknown_instrument');

        await seedConfiguredRegistry(
            repository,
            [...CONFIGURED, ETH],
            'BTCUSDT',
            ['BTCUSDT', 'ETHUSDT'],
        );

        // The judgement the route and the cycle both rely on.
        const afterSeed = await repository.tradability('ETHUSDT');

        expect(afterSeed.tradable).toBe(true);
    });

    it('keeps the single-instrument fields describing the named market', async () => {
        // The additive shape has to be additive: a caller reading `instrument` gets
        // the answer it got before this took a list, or the fix changed a
        // contract instead of extending one.
        const seeded = await seedConfiguredRegistry(
            repository,
            [...CONFIGURED, ETH],
            'BTCUSDT',
            ['BTCUSDT', 'ETHUSDT'],
        );

        expect(seeded.instrument).toBe('BTCUSDT');
        expect(seeded.instrumentInserted).toBe(true);
    });

    it('writes each market once when the list repeats it', async () => {
        const seeded = await seedConfiguredRegistry(
            repository,
            [...CONFIGURED, ETH],
            'BTCUSDT',
            ['BTCUSDT', 'ethusdt', 'ETHUSDT'],
        );

        // Normalised and de-duplicated: two entries for one market would report two
        // writes for one row, and the second would claim `inserted: false` for a
        // row this very call created.
        expect(seeded.instruments).toEqual([
            { ticker: 'BTCUSDT', inserted: true },
            { ticker: 'ETHUSDT', inserted: true },
        ]);

        expect(await repository.listInstruments()).toHaveLength(2);
    });
});
