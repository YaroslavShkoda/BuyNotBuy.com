/**
 * The asset registry in the database, with configuration on top.
 *
 * Migration 15 made the two tables. This is the code that reads and writes them,
 * and the direction of authority between the two sources is the whole design.
 *
 * **The database decides what this process knows. Configuration decides what it
 * is allowed to trade.** Concretely:
 *
 * - An asset in configuration but marked `inactive` in the database is not
 *   tradable. Configuration says "I would like to trade this"; the database
 *   says "this one is not for now"; the database wins, because the row is the
 *   one with a reason attached.
 * - A symbol in configuration that the database has never heard of is written
 *   in, because refusing to start on a new market is the property PHASE 1 was
 *   meant to remove. It is written with `source = 'configured'`, so it is
 *   visibly a person's opinion rather than a learned one.
 * - A symbol learned from data that configuration also lists keeps the learned
 *   category. Overwriting a measurement with a default on every restart would
 *   make PHASE 14 undo itself each time the process booted.
 *
 * **Nothing here is read at startup.** `config/market.config.ts` validates the
 * configured symbol against the configuration registry, without a database,
 * because `db/pool.ts` imports configuration and a registry that queried it
 * would close the loop. Startup validation answers "is this symbol well formed
 * and is it in the registry"; this answers "is this market one we may trade",
 * and the second question is worth asking again later than startup, because the
 * answer can change while the process runs.
 *
 * That is the reason the two are separate rather than merged: a check that
 * cannot be re-run is a check that is only ever right by accident.
 */

import { query, withTransaction } from '../db/pool.js';
import { resolveInstrument } from '../config/asset.registry.js';

import type { Asset, Instrument, TradabilityReason } from './domain.js';

export type AssetStatus = 'active' | 'inactive' | 'unknown';

export interface AssetRow {
    readonly symbol: string;
    readonly category: 'crypto' | 'fiat';
    readonly status: AssetStatus;
    readonly source: 'configured' | 'learned';
    readonly decidedAt: number;
}

export interface InstrumentRow {
    readonly ticker: string;
    readonly baseAsset: string;
    readonly quoteAsset: string;
    readonly marketKind: Instrument['market'];
    readonly status: 'active' | 'inactive';
}

/**
 * What a caller is allowed to do with a market, and the reason it may not.
 *
 * A boolean would be one thing too few. "Is BTCUSDT tradable?" being false is
 * a different incident from "is EURUSDT tradable?", and they are fixed by
 * different people: one by whoever suspended the asset, the other by whoever
 * mistyped the symbol.
 */
export type Tradability =
    | { readonly tradable: true; readonly instrument: Instrument }
    | { readonly tradable: false; readonly reason: TradabilityReason };

/** Re-exported, not redefined. The list itself lives in the domain vocabulary. */
export type { TradabilityReason } from './domain.js';

const DESCRIBE: Readonly<Record<TradabilityReason, string>> = {
    unknown_instrument: 'no such instrument in the registry',
    base_inactive: 'the base asset is not active',
    quote_inactive: 'the quote asset is not active',
    instrument_inactive: 'the instrument is not active',
    base_unknown: 'the base asset is not classified',
    quote_unknown: 'the quote asset is not classified',
};

const ASSET_SELECT = `
    SELECT symbol, category, status, source, decided_at AS "decidedAt"
    FROM asset
`;

const INSTRUMENT_SELECT = `
    SELECT ticker, base_asset AS "baseAsset", quote_asset AS "quoteAsset",
           market_kind AS "marketKind", status
    FROM instrument
`;

function toAsset(row: AssetRow): Asset {
    return {
        symbol: row.symbol,
        name: row.symbol,
        category: row.category,
        status: row.status,
    };
}

/**
 * The rule, with no database underneath it.
 *
 * **Not exported, although round 42 wrote it as an export "for the tests".**
 * The tests ended up comparing the two call paths against each other through
 * the public surface, so nothing ever imported this. An export written for an
 * imagined consumer is the same defect as a table written for an imagined
 * reader: it costs a public surface and answers nothing.
 *
 * **It was a loop body, and a loop body that decides whether a market may be
 * traded cannot stay one.** `tradability()` does two queries per call, and the
 * `/api/instruments` route added last round called it once per instrument —
 * twenty-odd round trips to answer a question about ten rows. The obvious fix
 * is to write the rule a second time in the controller against rows it already
 * has, and that is the fix that would have bitten: two copies of a rule with
 * six branches and a specific precedence, agreeing today and diverging the day
 * one of them is edited.
 *
 * So the rule lives here, once, and both callers use it. The precedence is
 * deliberate and is the part worth stating: **inactive before unknown**, and
 * **base before quote** in both. A suspended asset is a decision somebody made
 * and an unclassified one is a gap in what the system knows; reporting the gap
 * to somebody who has already suspended the market hides the decision behind
 * the gap.
 *
 * `unknown` and *absent* are different, and the schema is what makes them the
 * same. Both halves are `REFERENCES asset (symbol)`, so an instrument cannot
 * name an asset the table has never heard of — which is why the optional
 * chaining below does not treat absence as `unknown`, and why `toAsset(base!)`
 * is safe. If that foreign key is ever dropped, this function will answer
 * `tradable: true` for a pair with no assets and then throw inside `toAsset`.
 * That is a loud failure rather than a wrong answer, and it is the correct
 * order: the loud one takes a maintenance action.
 */
function judgeTradability(
    instrumentRow: InstrumentRow | undefined,
    bySymbol: ReadonlyMap<string, AssetRow>,
): Tradability {
    if (!instrumentRow) {
        return { tradable: false, reason: 'unknown_instrument' };
    }

    if (instrumentRow.status !== 'active') {
        return { tradable: false, reason: 'instrument_inactive' };
    }

    const base = bySymbol.get(instrumentRow.baseAsset);
    const quote = bySymbol.get(instrumentRow.quoteAsset);

    if (base?.status === 'inactive') {
        return { tradable: false, reason: 'base_inactive' };
    }

    if (quote?.status === 'inactive') {
        return { tradable: false, reason: 'quote_inactive' };
    }

    if (base?.status === 'unknown' || quote?.status === 'unknown') {
        return {
            tradable: false,
            reason: base?.status === 'unknown' ? 'base_unknown' : 'quote_unknown',
        };
    }

    return {
        tradable: true,
        instrument: {
            ticker: instrumentRow.ticker,
            base: toAsset(base!),
            quote: toAsset(quote!),
            market: instrumentRow.marketKind,
        },
    };
}

export class AssetRepository {
    async listAssets(): Promise<AssetRow[]> {
        const { rows } = await query<AssetRow>(`${ASSET_SELECT} ORDER BY symbol`);

        return rows;
    }

    async listInstruments(): Promise<InstrumentRow[]> {
        const { rows } = await query<InstrumentRow>(
            `${INSTRUMENT_SELECT} ORDER BY ticker`,
        );

        return rows;
    }

    /**
     * Writes the configured registry into the database, without overwriting
     * what is already there.
     *
     * The `ON CONFLICT DO NOTHING` is the decision, not a convenience. This runs
     * on every start, and an upsert that overwrote `status` would silently
     * re-activate an asset somebody suspended, and one that overwrote
     * `category` would discard a classification learned from data. Both are
     * exactly the "old results never rewritten" rule, and both would be invisible
     * — the row would simply be wrong again, forever, with nothing saying so.
     */
    async seedFromConfiguration(
        entries: readonly { symbol: string; category: 'crypto' | 'fiat' }[],
    ): Promise<{ inserted: number }> {
        return await withTransaction(async (client) => {
            let inserted = 0;

            for (const entry of entries) {
                const result = await client.query(
                    `INSERT INTO asset (symbol, category, status, source, decided_at)
                     VALUES ($1, $2, 'active', 'configured', $3)
                     ON CONFLICT (symbol) DO NOTHING`,
                    [entry.symbol, entry.category, Date.now()],
                );

                inserted += result.rowCount ?? 0;
            }

            return { inserted };
        });
    }

    /**
     * Records an instrument and both of its halves, if the halves are not there
     * yet.
     *
     * The halves are inserted as `unknown` rather than as crypto. A pair whose
     * base nobody has classified is a pair whose kind is not known, and the
     * first version of this codebase had no way to say that — so it said
     * `crypto`, and BTCBRL was a crypto market until the type grew a third
     * answer.
     */
    async recordInstrument(ticker: string): Promise<boolean> {
        const resolved = resolveInstrument(ticker);

        if (!resolved) {
            return false;
        }

        return await withTransaction(async (client) => {
            for (const half of [resolved.base, resolved.quote]) {
                await client.query(
                    `INSERT INTO asset (symbol, category, status, source, decided_at)
                     VALUES ($1, $2, 'unknown', 'learned', $3)
                     ON CONFLICT (symbol) DO NOTHING`,
                    [half.symbol, half.category, Date.now()],
                );
            }

            const result = await client.query(
                `INSERT INTO instrument (ticker, base_asset, quote_asset, market_kind, status)
                 VALUES ($1, $2, $3, $4, 'active')
                 ON CONFLICT (ticker) DO NOTHING`,
                [ticker, resolved.base.symbol, resolved.quote.symbol, resolved.market],
            );

            return (result.rowCount ?? 0) > 0;
        });
    }

    /**
     * Every instrument judged against rows the caller already has.
     *
     * The batch form, for the caller that read the whole registry in order to
     * list it. Two queries instead of two per instrument, and — the reason this
     * is worth a method rather than a loop in a controller — the same
     * `judgeTradability` that the single-instrument path uses, so the two cannot
     * answer differently.
     */
    tradabilities(
        instruments: readonly InstrumentRow[],
        assets: readonly AssetRow[],
    ): ReadonlyMap<string, Tradability> {
        const bySymbol = new Map(assets.map((row) => [row.symbol, row]));
        const judged = new Map<string, Tradability>();

        for (const instrument of instruments) {
            judged.set(
                instrument.ticker,
                judgeTradability(instrument, bySymbol),
            );
        }

        return judged;
    }

    /**
     * Whether this process may trade a market right now.
     *
     * Checked against the database rather than against configuration, which is
     * the whole point of the direction. Configuration is read at startup and
     * cannot change; this is read per decision and can.
     */
    async tradability(ticker: string): Promise<Tradability> {
        const { rows } = await query<InstrumentRow>(
            `${INSTRUMENT_SELECT} WHERE ticker = $1`,
            [ticker],
        );

        const { rows: halves } = await query<AssetRow>(
            `${ASSET_SELECT} WHERE symbol = ANY($1::text[])`,
            [[rows[0]?.baseAsset ?? '', rows[0]?.quoteAsset ?? '']],
        );

        return judgeTradability(
            rows[0],
            new Map(halves.map((row) => [row.symbol, row])),
        );
    }

    /**
     * Records a category the data decided, once a person has not.
     *
     * **This is the one write in the repository that is allowed to change a
     * configured answer, and only a configured one.** `seedFromConfiguration`
     * uses `ON CONFLICT DO NOTHING` precisely so that what it writes survives;
     * a method that overwrote `source = 'learned'` with `'configured'` on the
     * next boot would erase the only evidence that anything in this system has
     * ever learned anything, and would do it silently and on every restart.
     *
     * The `WHERE source = 'configured'` is the whole policy, and it is what
     * keeps learning bounded rather than self-referential: a classification
     * learned from data can never be replaced by another classification learned
     * from data by this method, so a market cannot oscillate between two
     * answers by re-deciding the same question with the same evidence. A
     * disagreement between two learned verdicts is a fact to surface, not a
     * race to see which lands last.
     *
     * What it will not do is overwrite a person's explicit declaration, because
     * a human saying "this is a fiat pair" and the data disagreeing is a
     * question for a human, and resolving it automatically in favour of the
     * data would make the configuration a suggestion.
     */
    async recordLearnedCategory(
        symbol: string,
        category: 'crypto' | 'fiat',
        decidedAt: number,
    ): Promise<{ changed: boolean }> {
        return await withTransaction(async (client) => {
            const result = await client.query(
                `UPDATE asset SET category = $2, source = 'learned', decided_at = $3
                 WHERE symbol = $1 AND source = 'configured' AND category <> $2`,
                [symbol, category, decidedAt],
            );

            return { changed: (result.rowCount ?? 0) > 0 };
        });
    }

    /** Suspends an asset, and with it every market priced in it. */
    async suspendAsset(symbol: string): Promise<void> {
        await withTransaction(async (client) => {
            await client.query(`UPDATE asset SET status = 'inactive' WHERE symbol = $1`, [
                symbol,
            ]);
        });
    }

    /** Records what a decision was based on, for the audit trail. */
    static describeReason(reason: TradabilityReason): string {
        return DESCRIBE[reason];
    }
}

let repositoryInstance: AssetRepository | null = null;

export function getAssetRepository(): AssetRepository {
    repositoryInstance ??= new AssetRepository();

    return repositoryInstance;
}
