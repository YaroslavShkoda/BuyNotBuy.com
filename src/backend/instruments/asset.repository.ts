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

import type { Asset, Instrument } from './domain.js';

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

export type TradabilityReason =
    | 'unknown_instrument'
    | 'base_inactive'
    | 'quote_inactive'
    | 'instrument_inactive'
    | 'base_unknown'
    | 'quote_unknown';

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

        const instrumentRow = rows[0];

        if (!instrumentRow) {
            return { tradable: false, reason: 'unknown_instrument' };
        }

        if (instrumentRow.status !== 'active') {
            return { tradable: false, reason: 'instrument_inactive' };
        }

        const { rows: halves } = await query<AssetRow>(
            `${ASSET_SELECT} WHERE symbol = ANY($1::text[])`,
            [[instrumentRow.baseAsset, instrumentRow.quoteAsset]],
        );
        const bySymbol = new Map(halves.map((row) => [row.symbol, row]));
        const base = bySymbol.get(instrumentRow.baseAsset);
        const quote = bySymbol.get(instrumentRow.quoteAsset);

        if (base?.status === 'inactive') {
            return { tradable: false, reason: 'base_inactive' };
        }

        if (quote?.status === 'inactive') {
            return { tradable: false, reason: 'quote_inactive' };
        }

        if (base?.status === 'unknown' || quote?.status === 'unknown') {
            return { tradable: false, reason: base?.status === 'unknown' ? 'base_unknown' : 'quote_unknown' };
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
