import type { AssetRow, InstrumentRow, TradabilityReason } from '../../instruments/asset.repository.js';
import { getAssetRepository } from '../../instruments/asset.repository.js';
import type { AssetCategory, AssetStatus } from '../../instruments/domain.js';
import type { InstrumentDto } from '../schemas.js';
import {
    InstrumentResponseSchema,
    InstrumentsResponseSchema,
} from '../schemas.js';

/**
 * The registry, read.
 *
 * **`instrumentFrom` is the domain function and the rows are the stored answer,
 * and the difference is the point.** The registry in configuration can split a
 * ticker and say what kind of market it is; the rows say what the system has
 * actually learned about the assets in it — their status, and whether a person
 * declared that category or the classification came out of observed data. A
 * client that could only see `instrumentFrom` would see the configuration and
 * not the system.
 *
 * The join is in this file rather than in SQL because it is three small tables
 * and one rule that must not be got wrong: an instrument whose assets are not
 * all in `AssetRow` is not "partially known", it is **not answerable**. A row
 * that reported `category: 'crypto'` for a base asset the database has never
 * seen would be inventing the classification this project spends PHASE 14
 * learning. Those instruments are left out of the list rather than filled in,
 * and `unknown` is what a real row says — not a default.
 */

/** Assets the registry has not learned about are absent, never defaulted. */
function indexAssets(
    assets: readonly AssetRow[],
): ReadonlyMap<string, InstrumentAsset> {
    const bySymbol = new Map<string, InstrumentAsset>();

    for (const asset of assets) {
        bySymbol.set(asset.symbol, {
            symbol: asset.symbol,
            category: asset.category,
            status: asset.status,
            source: asset.source,
        });
    }

    return bySymbol;
}

interface InstrumentAsset {
    readonly symbol: string;
    readonly category: AssetCategory;
    readonly status: AssetStatus;
    readonly source: 'configured' | 'learned';
}

function toDto(
    instrument: InstrumentRow,
    base: InstrumentAsset,
    quote: InstrumentAsset,
    reason: TradabilityReason | null,
): InstrumentDto {
    return {
        ticker: instrument.ticker,
        base,
        quote,
        market: instrument.marketKind,
        status: instrument.status,
        tradable: reason === null,
        reason,
    };
}

/** Every instrument whose two assets are both known, in a stable order. */
export async function listInstruments(): Promise<InstrumentDto[]> {
    const repository = getAssetRepository();
    const [instruments, assets] = await Promise.all([
        repository.listInstruments(),
        repository.listAssets(),
    ]);

    const bySymbol = indexAssets(assets);
    const judged = repository.tradabilities(instruments, assets);
    const answers: InstrumentDto[] = [];

    for (const instrument of instruments) {
        const base = bySymbol.get(instrument.baseAsset);
        const quote = bySymbol.get(instrument.quoteAsset);

        if (base === undefined || quote === undefined) {
            continue;
        }

        const verdict = judged.get(instrument.ticker);

        answers.push(
            toDto(
                instrument,
                base,
                quote,
                verdict === undefined || verdict.tradable ? null : verdict.reason,
            ),
        );
    }

    return answers.sort((left, right) => left.ticker.localeCompare(right.ticker));
}

/**
 * One instrument, or the reason it cannot be answered.
 *
 * Not exported: `instrumentPayload` below is its only caller, and an export with
 * no importer is a promise to a module that does not exist. A measurement over
 * the tree found this one three days after it was written, which is the point of
 * running the measurement rather than reading the file.
 *
 * `null` for a ticker the registry has never heard of, which is not the same as
 * a refusal: an instrument that exists and may not be traded comes back with
 * `tradable: false` and a reason, because that is a decision somebody made. A
 * ticker that does not exist has no decision behind it and gets a 404.
 */
async function getInstrument(ticker: string): Promise<InstrumentDto | null> {
    const repository = getAssetRepository();
    const instruments = await repository.listInstruments();
    const assets = await repository.listAssets();

    const instrument = instruments.find((row) => row.ticker === ticker);

    if (instrument === undefined) {
        return null;
    }

    const bySymbol = indexAssets(assets);
    const base = bySymbol.get(instrument.baseAsset);
    const quote = bySymbol.get(instrument.quoteAsset);

    if (base === undefined || quote === undefined) {
        return null;
    }

    // The single-instrument path, not a lookup in the batch map: one ticker
    // asked for on its own is two queries, and reusing `tradability` here means
    // this endpoint and the batch one cannot answer differently.
    const tradability = await repository.tradability(instrument.ticker);

    return toDto(
        instrument,
        base,
        quote,
        tradability.tradable ? null : tradability.reason,
    );
}

/** Zod-parsed, so the route validates what it is about to send. */
export async function instrumentsPayload(): Promise<
    ReturnType<typeof InstrumentsResponseSchema.parse>
> {
    return InstrumentsResponseSchema.parse({ instruments: await listInstruments() });
}

export async function instrumentPayload(
    ticker: string,
): Promise<ReturnType<typeof InstrumentResponseSchema.parse> | null> {
    const found = await getInstrument(ticker);

    return found === null ? null : InstrumentResponseSchema.parse(found);
}
