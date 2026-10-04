import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../db/pool.js';
import { AssetRepository } from './asset.repository.js';

const repository = new AssetRepository();

const CONFIGURED = [
    { symbol: 'BTC', category: 'crypto' as const },
    { symbol: 'USDT', category: 'crypto' as const },
    { symbol: 'EUR', category: 'fiat' as const },
];

describe('AssetRepository', () => {
    beforeEach(async () => {
        await query('DELETE FROM instrument');
        await query('DELETE FROM asset');
        await repository.seedFromConfiguration(CONFIGURED);
        await repository.recordInstrument('BTCUSDT');
    });

    describe('seeding from configuration', () => {
        it('writes what configuration says on the first run', async () => {
            const assets = await repository.listAssets();

            expect(assets.map((row) => row.symbol)).toEqual(['BTC', 'EUR', 'USDT']);
        });

        it('marks them as configured, not learned', async () => {
            // A person typing a category and a classifier deriving one are
            // different facts, and PHASE 14 will produce the second kind. Storing
            // them identically means the first learned opinion is
            // indistinguishable from a default.
            const assets = await repository.listAssets();

            expect(assets.every((row) => row.source === 'configured')).toBe(true);
        });

        it('does not reactivate an asset somebody suspended', async () => {
            // The reason this is `ON CONFLICT DO NOTHING` rather than an upsert.
            // It runs on every start; an upsert that wrote `status` would bring
            // a suspended asset back on each restart, silently, forever.
            await repository.suspendAsset('BTC');
            await repository.seedFromConfiguration(CONFIGURED);

            const assets = await repository.listAssets();
            const btc = assets.find((row) => row.symbol === 'BTC');

            expect(btc?.status).toBe('inactive');
        });

        it('does not overwrite a classification learned from data', async () => {
            await query(`UPDATE asset SET category = 'fiat', source = 'learned' WHERE symbol = 'BTC'`);
            await repository.seedFromConfiguration(CONFIGURED);

            const assets = await repository.listAssets();
            const btc = assets.find((row) => row.symbol === 'BTC');

            // Old results are never rewritten. A learned category overwritten by
            // a default on every restart would make PHASE 14 undo itself.
            expect(btc?.category).toBe('fiat');
            expect(btc?.source).toBe('learned');
        });

        it('does not write the same asset twice', async () => {
            const result = await repository.seedFromConfiguration(CONFIGURED);

            expect(result.inserted).toBe(0);
            expect((await repository.listAssets()).length).toBe(3);
        });
    });

    describe('a category the data decided', () => {
        it('overwrites a configured answer, and marks where it came from', async () => {
            // The one write in this repository permitted to change what
            // configuration said, and the `source` column is the record of it.
            // Without that column the two would be indistinguishable, and "the
            // data decided" and "somebody typed it" are different facts with
            // different consequences when they disagree.
            const result = await repository.recordLearnedCategory('BTC', 'fiat', 1_700_000_000_000);

            expect(result.changed).toBe(true);

            const btc = (await repository.listAssets()).find((a) => a.symbol === 'BTC');

            expect(btc?.category).toBe('fiat');
            expect(btc?.source).toBe('learned');
        });

        it('never replaces a classification that was already learned', async () => {
            // **The bound on self-learning.** If this method could overwrite a
            // learned row, the registry would be able to re-decide the same
            // question with the same evidence forever — a market oscillating
            // between two answers, each one erasing the evidence for the other.
            // A disagreement between two learned verdicts is a fact to surface,
            // not a race to see which lands last.
            await repository.recordLearnedCategory('BTC', 'fiat', 1);
            const second = await repository.recordLearnedCategory('BTC', 'crypto', 2);

            expect(second.changed).toBe(false);

            const btc = (await repository.listAssets()).find((a) => a.symbol === 'BTC');
            expect(btc?.category).toBe('fiat');
        });

        it('reports no change when the data agrees with configuration', async () => {
            // Agreeing is the normal case and must not rewrite the row, because
            // rewriting it would replace `decided_at` with the time the system
            // last happened to check, and the column would then answer "when
            // was this last verified" while looking like "when was this decided".
            const result = await repository.recordLearnedCategory('BTC', 'crypto', 999);

            expect(result.changed).toBe(false);

            const btc = (await repository.listAssets()).find((a) => a.symbol === 'BTC');
            expect(btc?.source).toBe('configured');
        });

        it('does not invent an asset the registry has never heard of', async () => {
            // A learned category is a claim about a row that exists. Writing one
            // for a symbol nobody registered would create an asset that no
            // configuration declared and no instrument references, which is a
            // row nothing will ever clean up.
            const result = await repository.recordLearnedCategory('ZZZ', 'fiat', 1);

            expect(result.changed).toBe(false);
            expect((await repository.listAssets()).some((a) => a.symbol === 'ZZZ')).toBe(false);
        });

        it('leaves a learned category standing across a reseed', async () => {
            // The pair of behaviours that make the two rules hold together: the
            // seed must not undo the learning, and the learning must not be able
            // to undo a person. Boot runs the seed on every start.
            await repository.recordLearnedCategory('BTC', 'fiat', 1);
            await repository.seedFromConfiguration([
                { symbol: 'BTC', category: 'crypto' as const },
            ]);

            const btc = (await repository.listAssets()).find((a) => a.symbol === 'BTC');
            expect(btc?.category).toBe('fiat');
        });
    });

    describe('recording an instrument', () => {
        it('writes the pair and both halves', async () => {
            const instruments = await repository.listInstruments();

            expect(instruments).toEqual([
                {
                    ticker: 'BTCUSDT',
                    baseAsset: 'BTC',
                    quoteAsset: 'USDT',
                    marketKind: 'crypto',
                    status: 'active',
                },
            ]);
        });

        it('marks halves it had to invent as unclassified rather than as crypto', async () => {
            // The first version of this codebase had no way to say "not known",
            // so it said crypto, and BTCBRL was a crypto market. An invented
            // half is not a classified one.
            //
            // Written as a ticker with a genuinely absent half rather than by
            // deleting one first: deleting an asset that an instrument still
            // references is refused by the foreign key, which is the constraint
            // doing its job and not a test to work around.
            expect(await repository.recordInstrument('XRPBTC')).toBe(true);

            const assets = await repository.listAssets();
            const xrp = assets.find((row) => row.symbol === 'XRP');

            expect(xrp).toMatchObject({ symbol: 'XRP', status: 'unknown' });
        });

        it('records a half it already knows as classified, not unknown', async () => {
            await repository.recordInstrument('XRPBTC');

            const assets = await repository.listAssets();

            expect(assets.find((row) => row.symbol === 'BTC')?.status).toBe('active');
            expect(assets.find((row) => row.symbol === 'XRP')?.status).toBe('unknown');
        });

        it('refuses a ticker that is not a pair at all', async () => {
            expect(await repository.recordInstrument('1h')).toBe(false);
            expect(await repository.recordInstrument('binance')).toBe(false);
            expect((await repository.listInstruments()).length).toBe(1);
        });
    });

    describe('whether a market may be traded', () => {
        it('allows a registered, active market', async () => {
            const verdict = await repository.tradability('BTCUSDT');

            expect(verdict.tradable).toBe(true);
        });

        it('names both halves rather than returning the instrument alone', async () => {
            const verdict = await repository.tradability('BTCUSDT');

            if (!verdict.tradable) {
                throw new Error('expected the market to be tradable');
            }

            expect(verdict.instrument.base.symbol).toBe('BTC');
            expect(verdict.instrument.quote.symbol).toBe('USDT');
            expect(verdict.instrument.market).toBe('crypto');
        });

        it('refuses a market the database has never heard of', async () => {
            await repository.recordInstrument('ETHBTC');

            const verdict = await repository.tradability('ETHUSDT');

            expect(verdict).toEqual({ tradable: false, reason: 'unknown_instrument' });
        });

        it('lets the database refuse what configuration still lists', async () => {
            // The direction of authority, in one test. Configuration says BTC is
            // wanted — it is in the seed list, and it will be seeded again on
            // every start. The suspension is the newer fact and the one with a
            // reason attached, so it wins.
            await repository.suspendAsset('BTC');

            const verdict = await repository.tradability('BTCUSDT');

            expect(verdict).toEqual({ tradable: false, reason: 'base_inactive' });
        });

        it('refuses a market whose quote is suspended', async () => {
            await repository.suspendAsset('USDT');

            expect(await repository.tradability('BTCUSDT')).toEqual({
                tradable: false,
                reason: 'quote_inactive',
            });
        });

        it('refuses a market whose halves are unclassified, and says which', async () => {
            await query(`UPDATE asset SET status = 'unknown' WHERE symbol = 'USDT'`);

            expect(await repository.tradability('BTCUSDT')).toEqual({
                tradable: false,
                reason: 'quote_unknown',
            });
        });

        it('refuses a suspended instrument itself', async () => {
            await query(`UPDATE instrument SET status = 'inactive' WHERE ticker = 'BTCUSDT'`);

            expect(await repository.tradability('BTCUSDT')).toEqual({
                tradable: false,
                reason: 'instrument_inactive',
            });
        });

        it('explains every reason it can give', () => {
            // A refusal with no sentence is a refusal with nothing to act on, and
            // the six reasons are fixed by different people.
            for (const reason of [
                'unknown_instrument',
                'base_inactive',
                'quote_inactive',
                'instrument_inactive',
                'base_unknown',
                'quote_unknown',
            ] as const) {
                expect(AssetRepository.describeReason(reason).length).toBeGreaterThan(4);
            }
        });

        it('re-reads the answer each time rather than caching it', async () => {
            // The reason this is not read at startup. A check that can only be
            // performed once is right by accident; a suspension that arrives
            // after the process started has to be able to take effect.
            expect((await repository.tradability('BTCUSDT')).tradable).toBe(true);
            await repository.suspendAsset('BTC');
            expect((await repository.tradability('BTCUSDT')).tradable).toBe(false);
            await query(`UPDATE asset SET status = 'active' WHERE symbol = 'BTC'`);
            expect((await repository.tradability('BTCUSDT')).tradable).toBe(true);
        });
    });

    describe('the batch path and the single one', () => {
        /**
         * The risk of extracting a rule out of a loop body is that two copies
         * agree today and diverge the day one is edited. So this does not check
         * that the batch is fast or that it returns something — it checks that
         * the two paths give **the same answer for every state the schema can
         * produce**, including the ones where the precedence decides.
         *
         * The states are driven into the database rather than built as literals,
         * so the two implementations are compared on real rows and the
         * `REFERENCES` constraint is doing its job throughout.
         */
        const reasonOf = (verdict: unknown): string | null => {
            const typed = verdict as { tradable: boolean; reason?: string };

            return typed.tradable ? null : (typed.reason ?? null);
        };

        /** The two paths, side by side, for the pair this file seeds. */
        const bothPaths = async (): Promise<[string | null, string | null]> => {
            const [instruments, assets] = await Promise.all([
                repository.listInstruments(),
                repository.listAssets(),
            ]);

            const batch = repository.tradabilities(instruments, assets);

            return [
                reasonOf(await repository.tradability('BTCUSDT')),
                reasonOf(batch.get('BTCUSDT')),
            ];
        };

        it('answers the same for every state, including the precedence ties', async () => {
            // The base suspended.
            await repository.suspendAsset('BTC');
            await expect(bothPaths()).resolves.toEqual(['base_inactive', 'base_inactive']);
            await query(`UPDATE asset SET status = 'active' WHERE symbol = 'BTC'`);

            // The quote unclassified, which the base shares — so this is the
            // precedence under test rather than the categories themselves.
            await query(`UPDATE asset SET status = 'unknown' WHERE symbol = 'USDT'`);
            await expect(bothPaths()).resolves.toEqual(['quote_unknown', 'quote_unknown']);

            // Both unclassified: the base must be named, not the quote.
            await query(`UPDATE asset SET status = 'unknown' WHERE symbol = 'BTC'`);
            await expect(bothPaths()).resolves.toEqual(['base_unknown', 'base_unknown']);

            // Both suspended, which must report the base rather than the quote:
            // an inactive asset outranks an unclassified one because somebody
            // made that decision and nobody has made this one.
            await query(`UPDATE asset SET status = 'inactive'`);
            await expect(bothPaths()).resolves.toEqual(['base_inactive', 'base_inactive']);
            await query(`UPDATE asset SET status = 'active'`);

            // **The state that decides the cross-precedence.** One half suspended
            // and the other unclassified is the only state where "inactive before
            // unknown" and "unknown before inactive" give different answers, so
            // without it the claim in the docstring is untested — the batch and
            // the single path can agree perfectly on states that never collide.
            await query(`UPDATE asset SET status = 'active' WHERE symbol = 'BTC'`);
            await query(`UPDATE asset SET status = 'unknown' WHERE symbol = 'USDT'`);
            await query(`UPDATE asset SET status = 'inactive' WHERE symbol = 'BTC'`);
            await expect(bothPaths()).resolves.toEqual(['base_inactive', 'base_inactive']);

            // And the mirror: the suspension is on the quote, so it must win over
            // the base being unclassified. Reporting `base_unknown` here would
            // send the reader to the asset nobody suspended.
            await query(`UPDATE asset SET status = 'active' WHERE symbol = 'BTC'`);
            await query(`UPDATE asset SET status = 'unknown' WHERE symbol = 'BTC'`);
            await query(`UPDATE asset SET status = 'inactive' WHERE symbol = 'USDT'`);
            await expect(bothPaths()).resolves.toEqual(['quote_inactive', 'quote_inactive']);
            await query(`UPDATE asset SET status = 'active'`);

            // The instrument itself suspended, which outranks both halves.
            await query(
                `UPDATE instrument SET status = 'inactive' WHERE ticker = 'BTCUSDT'`,
            );
            await expect(bothPaths()).resolves.toEqual([
                'instrument_inactive',
                'instrument_inactive',
            ]);
        });

        it('answers "unknown" for a ticker it has never heard of', async () => {
            // The one case with no row at all, where the batch has nothing to
            // look up and the single path has to survive an empty result.
            const [instruments, assets] = await Promise.all([
                repository.listInstruments(),
                repository.listAssets(),
            ]);
            const batch = repository.tradabilities(instruments, assets);

            expect(await repository.tradability('NOSUCH')).toEqual({
                tradable: false,
                reason: 'unknown_instrument',
            });
            expect(batch.has('NOSUCH')).toBe(false);
        });
    });
});
