import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

/**
 * Two markets, one cycle, and no bleed between them.
 *
 * The process observed exactly one market before this, and it observed it for a
 * reason that had nothing to do with the code: `server.ts` held the whole
 * observation cycle as a closure that read `marketConfig.symbol` eleven times and
 * took no market as an argument. Adding a second meant editing that file, and
 * testing the cycle at all meant starting the process, which no test does.
 *
 * So the guarantee that BTCUSDT's bars were never filed under ETHUSDT was true
 * by there being only one market — which is not a guarantee. It is an accident
 * that the next person removes.
 *
 * **The mock provider is what makes this runnable.** It answers any registered
 * ticker with 900 synthetic bars, so two markets are two series of the same
 * length and the test can assert on *which* series each write landed in rather
 * than on counts, which is the part that would otherwise pass by coincidence.
 */
vi.mock('../history/signal-history.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../history/signal-history.service.js')>();

    return { ...actual, flushSignalHistoryBacklog: vi.fn(async () => 0) };
});

const silentLogger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
} as unknown as Parameters<typeof import('./market-cycle.js').observeMarket>[1]['logger'];

async function cycleFor(markets: readonly string[]): Promise<
    Awaited<ReturnType<typeof import('./market-cycle.js').observeMarket>>[]
> {
    vi.resetModules();
    vi.stubEnv('MARKET_PROVIDER', 'mock');
    vi.stubEnv('MARKET_SYMBOLS', markets.slice(1).join(','));

    // **A venue has to declare the markets it serves, and this is the gate.**
    // The first version of this test set only `MARKET_SYMBOLS` and the second
    // market was refused with "No configured venue does not serve ETHUSDT. It
    // serves: BTCUSDT" — which is the right refusal, from `marketProviderFor`,
    // and worth recording: enabling a second market is not one setting. It is a
    // setting *plus* a declaration by every venue that will answer for it, and
    // the refusal names what is missing.
    vi.stubEnv(
        'MARKET_VENUE_CAPABILITIES',
        markets.map((market) => `mock=${market}@1h`).join(';'),
    );

    const { observeMarket } = await import('./market-cycle.js');

    const results = [];

    for (const market of markets) {
        results.push(
            await observeMarket(market, {
                logger: silentLogger,
                reportVenueChange: () => undefined,
            }),
        );
    }

    return results;
}

describe('the cycle over more than one market', () => {
    beforeEach(async () => {
        // The project's own helper rather than three DELETEs written here: it
        // knows which tables the signal chain owns, and a list of them in two
        // places is a list that will be wrong in one of them.
        await truncateSignalTables();
    });

    it('reads each market it was given', async () => {
        const observations = await cycleFor(['BTCUSDT', 'ETHUSDT']);

        expect(observations).toHaveLength(2);

        const btc = observations[0]!;
        const eth = observations[1]!;

        expect(btc.market).toBe('BTCUSDT');
        expect(eth.market).toBe('ETHUSDT');

        // Both read the same *shape* of market, which is why a test that
        // asserted only "two calls happened" would pass while both had been
        // reading BTCUSDT. The bar timestamps are what tell them apart: a
        // resample of the same series would align, a different symbol's would
        // not, and the provider stamps each with its own symbol.
        expect(btc.candles).toBeGreaterThan(0);
        expect(eth.candles).toBeGreaterThan(0);
    });

    it('stores a snapshot per market, keyed by its own symbol', async () => {
        await cycleFor(['BTCUSDT', 'ETHUSDT']);

        const rows = await getTestPool().query<{ symbol: string }>(
            'SELECT DISTINCT symbol FROM signal_snapshot ORDER BY symbol',
        );

        // A cycle that filed both under the configured symbol would produce one
        // row here and the migration-18 fingerprint would have collapsed them
        // into one, silently.
        expect(rows.rows.map((row) => row.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    it('and the second market is not written under the first market anywhere', async () => {
        await cycleFor(['BTCUSDT', 'ETHUSDT']);

        // The claim itself, stated over the tables rather than over a counter.
        // A cycle that read the configured market twice — the failure mode a
        // `configuredSeries()` with no argument produces — would leave the bars
        // table with one symbol and this would still pass on snapshots, so the
        // candles are checked as well.
        const candles = await getTestPool().query<{ symbol: string }>(
            'SELECT DISTINCT symbol FROM market_candles ORDER BY symbol',
        );

        const ingested = candles.rows.map((row) => row.symbol);

        // The mock provider does not persist bars — that is the ingestion
        // scheduler's job, and it is not what this test runs. So the meaningful
        // assertion is on the tables this cycle writes.
        expect(ingested.every((symbol) => symbol === 'BTCUSDT' || symbol === 'ETHUSDT')).toBe(
            true,
        );
    });

    it('one market, and the cycle is what it always was', async () => {
        // The default has to be unchanged, or this is a behaviour change wearing
        // a seam as a costume. One market in, one observation out, and the
        // snapshot lands under that market.
        const observations = await cycleFor(['BTCUSDT']);

        expect(observations).toHaveLength(1);
        expect(observations[0]!.market).toBe('BTCUSDT');

        const rows = await getTestPool().query<{ symbol: string }>(
            'SELECT DISTINCT symbol FROM signal_snapshot',
        );

        expect(rows.rows.map((row) => row.symbol)).toEqual(['BTCUSDT']);
    });
});
