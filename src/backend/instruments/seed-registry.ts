import type { AssetRepository } from './asset.repository.js';
import type { Asset } from './domain.js';

export interface SeededRegistry {
    /** Assets newly written. Existing rows are left exactly as they were. */
    readonly assetsInserted: number;
    /** The configured instrument, and whether this call was what created it. */
    readonly instrument: string;
    readonly instrumentInserted: boolean;
    /**
     * Every configured market that was written, and which of them this call
     * created.
     *
     * Additive, and additive for a reason: the first two fields describe **one**
     * instrument and this one describes all of them, and a return shape that could
     * only say "one" is the shape that seeded one.
     */
    readonly instruments: readonly {
        readonly ticker: string;
        readonly inserted: boolean;
    }[];
}

/**
 * Writes the configured registry into the database, before the socket opens.
 *
 * **This function exists because the two halves were written in different places
 * and only one of them ran.** `server.ts` seeded assets and recorded the market's
 * category when a classifier learned something, but nothing in the running
 * service ever wrote the `instrument` table: `recordInstrument` had callers only
 * in tests. So `GET /api/instruments` answered with an empty list on every live
 * deployment, next to a correctly seeded asset list that made the emptiness look
 * like "no instruments configured" rather than "nothing writes here".
 *
 * Both halves belong to the same operation — the registry the configuration
 * declares, written down — and they are the same operation here for a reason
 * beyond tidiness: the controller treats an instrument whose assets are not all
 * in `asset` as **not answerable**, and leaves it out of the list rather than
 * inventing a classification. An instrument row written without its halves would
 * therefore be worse than an absent one, which is a second reason this could not
 * be fixed in the route.
 *
 * The ticker is a parameter rather than read from configuration here, so that
 * the property which broke — after seeding, the registry route can answer — is
 * a thing a test can state. Read from the module inside this function, there
 * would be no way to test it without booting the process, and an untestable
 * invariant is the one that silently stops holding.
 */
export async function seedConfiguredRegistry(
    repository: AssetRepository,
    assets: readonly Asset[],
    ticker: string,
    tickers: readonly string[] = [ticker],
): Promise<SeededRegistry> {
    const assetsSeeded = await repository.seedFromConfiguration(
        assets.map((entry) => ({ symbol: entry.symbol, category: entry.category })),
    );

    // Resolvable by the caller: every configured market is checked against this
    // same registry at import time and the process refuses to start otherwise.
    //
    // **Every configured market, and this was the item.** It recorded one
    // instrument — the one the caller named — so a process observing two markets
    // wrote rows for one of them. The other had no `instrument` row, which means
    // `judgeTradability` answered `unknown_instrument` for it,
    // `GET /api/instruments` left it out, and its `asset` rows landed with
    // `status: 'unknown'`.
    //
    // None of that is corruption and all of it is a registry that under-reports:
    // the controller deliberately leaves an instrument whose assets are not all in
    // `asset` out of the list rather than inventing a classification, and
    // `recordInstrument` is what writes the halves. A second market observed every
    // minute and absent from the registry is a market the system says it does not
    // trade.
    const written: { ticker: string; inserted: boolean }[] = [];

    for (const configured of [...new Set(tickers.map((name) => name.trim().toUpperCase()))]) {
        written.push({
            ticker: configured,
            inserted: await repository.recordInstrument(configured),
        });
    }

    // The single-instrument fields describe the named one, so a caller reading them
    // gets the answer it would have got before this took a list.
    const named = written.find((entry) => entry.ticker === ticker.toUpperCase()) ?? {
        ticker,
        inserted: false,
    };

    return {
        assetsInserted: assetsSeeded.inserted,
        instrument: named.ticker,
        instrumentInserted: named.inserted,
        instruments: written,
    };
}
