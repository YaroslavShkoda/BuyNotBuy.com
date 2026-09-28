import { beforeEach, describe, expect, it } from 'vitest';

import { query } from '../db/pool.js';

/**
 * The SQLSTATE of a failure, which does not change with the database language.
 *
 * Matching on the message text would make every assertion here depend on the
 * server's locale — this project runs a Russian-language PostgreSQL, so the
 * first version of these tests looked for `/foreign key/` and were refused by
 * «нарушает ограничение внешнего ключа». The code is the part that is a fact
 * about the database rather than about the installation.
 */
async function sqlstateOf(run: Promise<unknown>): Promise<string> {
    try {
        await run;
    } catch (error) {
        return (error as { code?: string }).code ?? '';
    }

    throw new Error('expected the statement to be refused, and it was accepted');
}

/**
 * Migration 15, verified by trying to write things that should not exist.
 *
 * These are not assertions about a schema string. Every one of them is an
 * INSERT that must fail, because the value of a CHECK constraint is entirely
 * in whether the database refuses — and a test that reads `pg_constraint` would
 * pass against a constraint that had been defined wrong and never fired.
 */
describe('asset and instrument', () => {
    beforeEach(async () => {
        await query('DELETE FROM instrument');
        await query('DELETE FROM asset');

        await query(
            `INSERT INTO asset (symbol, category, decided_at)
             VALUES ('BTC', 'crypto', 0), ('USDT', 'crypto', 0), ('ETH', 'crypto', 0),
                    ('EUR', 'fiat', 0)`,
        );
    });

    it('holds a coin', async () => {
        const { rows } = await query<{ symbol: string; category: string }>(
            `SELECT symbol, category FROM asset WHERE symbol = 'BTC'`,
        );

        expect(rows).toEqual([{ symbol: 'BTC', category: 'crypto' }]);
    });

    it('holds a pair as its two halves rather than as a string', async () => {
        const { rows } = await query<{
            ticker: string;
            base_asset: string;
            quote_asset: string;
            market_kind: string;
        }>(
            `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
             VALUES ('BTCUSDT', 'BTC', 'USDT', 'crypto')
             RETURNING ticker, base_asset, quote_asset, market_kind`,
        );

        expect(rows[0]).toEqual({
            ticker: 'BTCUSDT',
            base_asset: 'BTC',
            quote_asset: 'USDT',
            market_kind: 'crypto',
        });
    });

    it('refuses a ticker that is not its two halves written together', async () => {
        // The constraint that earns the migration. The parser already
        // guarantees this, and a guarantee that lives only in the code that
        // writes the rows lasts exactly until the first other writer — at which
        // point the table would hold a BTCUSDT whose base is ETH and every
        // reader that trusts the ticker would be wrong with nothing disagreeing.
        await expect(
            query(
                `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
                 VALUES ('BTCUSDT', 'ETH', 'USDT', 'crypto')`,
            ),
        ).rejects.toThrow(/instrument_ticker_is_its_halves/);
    });

    it('refuses a pair whose halves are the same asset', async () => {
        await expect(
            query(
                `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
                 VALUES ('BTCBTC', 'BTC', 'BTC', 'crypto')`,
            ),
        ).rejects.toThrow(/instrument_halves_differ/);
    });

    it('refuses a market kind it has never heard of', async () => {
        // Including a spelling that is nearly right. A future writer who
        // believes the column is called 'fiat_crypto' should be refused at the
        // insert, not discovered later while reading rows.
        await expect(
            query(
                `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
                 VALUES ('ETHUSDT', 'ETH', 'USDT', 'spot')`,
            ),
        ).rejects.toThrow(/instrument_market_kind_known/);
    });

    it('refuses a half that is not a known asset', async () => {
        // A foreign key, and the one that makes the table a registry rather
        // than a second spelling of the same string.
        expect(
            await sqlstateOf(
                query(
                    `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
                     VALUES ('DOGEUSDT', 'DOGE', 'USDT', 'crypto')`,
                ),
            ),
        ).toBe('23503');
    });

    it('refuses an asset symbol that is not a ticker', async () => {
        await expect(
            query(`INSERT INTO asset (symbol, category, decided_at) VALUES ('btc', 'crypto', 0)`),
        ).rejects.toThrow(/asset_symbol_shaped/);
    });

    it('refuses a category that is not one of the two kinds', async () => {
        await expect(
            query(`INSERT INTO asset (symbol, category, decided_at) VALUES ('DOGE', 'pet', 0)`),
        ).rejects.toThrow(/asset_category_known/);
    });

    it('accepts a market kind of unknown, because not knowing is an answer', async () => {
        // The third value. Without it the only way to record a pair whose quote
        // is unrecognised is to lie and say crypto, which is how BTCBRL became
        // a crypto market the first time.
        const { rows } = await query<{ market_kind: string }>(
            `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind)
             VALUES ('ETHEUR', 'ETH', 'EUR', 'fiat')
             RETURNING market_kind`,
        );

        expect(rows[0]?.market_kind).toBe('fiat');
    });

    it('records where an opinion came from, so a learned one can be told apart', async () => {
        const { rows } = await query<{ source: string }>(
            `INSERT INTO asset (symbol, category, decided_at, source)
             VALUES ('XRP', 'crypto', 0, 'learned')
             RETURNING source`,
        );

        expect(rows[0]?.source).toBe('learned');
    });

    it('refuses a provenance it does not recognise', async () => {
        await expect(
            query(
                `INSERT INTO asset (symbol, category, decided_at, source)
                 VALUES ('XRP', 'crypto', 0, 'guessed')`,
            ),
        ).rejects.toThrow(/asset_source_known/);
    });

    it('will not let one coin be two categories at once', async () => {
        // The first version had no category column; the second had it but no
        // primary key discipline. This is the check that a lookup cannot be
        // order-dependent.
        expect(
            await sqlstateOf(
                query(
                    `INSERT INTO asset (symbol, category, decided_at)
                     VALUES ('BTC', 'fiat', 0)`,
                ),
            ),
        ).toBe('23505');
    });

    it('counts the checks it is supposed to have', async () => {
        // Pinned so that a constraint cannot be dropped in a later migration
        // and leave every other test in this file passing for the wrong reason.
        const { rows } = await query<{ total: string }>(
            `SELECT COUNT(*)::text AS total
             FROM information_schema.table_constraints
             WHERE table_name IN ('asset', 'instrument')
               AND constraint_type = 'CHECK'`,
        );

        expect(Number(rows[0]?.total)).toBeGreaterThanOrEqual(9);
    });
});
