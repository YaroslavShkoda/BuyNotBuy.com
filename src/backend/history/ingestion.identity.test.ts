import { beforeEach, describe, expect, it } from 'vitest';

import '../test-support/test-database.js';

import { ingestOnce } from './ingestion.service.js';
import { createCandleRepository } from './candle.repository.js';
import { getTestPool, truncateSignalTables } from '../test-support/test-database.js';

import type { CandleSeriesKey } from './candle.repository.js';
import type { MarketDataProvider } from '../market/providers/market-data.provider.js';
import type { Candle } from '../types/market.js';

const HOUR = 3_600_000;
/** Aligned to the hour, because a venue labels a bar by its opening instant. */
const NEWEST = 1_699_999_200_000;
/** Half an hour into the hour that opened at NEWEST. */
const AT = NEWEST + 30 * 60_000;

const BTC: CandleSeriesKey = {
    provider: 'binance',
    symbol: 'BTCUSDT',
    interval: '1h',
};

const ETH: CandleSeriesKey = {
    provider: 'binance',
    symbol: 'ETHUSDT',
    interval: '1h',
};

function bar(timestamp: number): Candle {
    return {
        timestamp,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
    };
}

function rollingWindow(): Candle[] {
    return Array.from({ length: 10 }, (_, index) => bar(NEWEST - index * HOUR));
}

/** A venue that names its own symbol, and counts the fetches it was asked for. */
function venue(
    symbol: string,
    candles: readonly Candle[],
): MarketDataProvider & { calls: number } {
    const provider = {
        name: 'binance',
        symbol,
        calls: 0,
        getPrice: async () => ({ symbol, price: 100 }),
        getCandles: async () => [...candles],
        getAttributedCandles: async () => ({
            venue: 'binance',
            symbol,
            candles: [...candles],
        }),
        getHistoricalCandles: async () => {
            provider.calls += 1;

            return [...candles];
        },
    };

    return provider;
}

async function countFor(symbol: string): Promise<number> {
    const result = await getTestPool().query(
        'SELECT COUNT(*)::int AS total FROM market_candles WHERE symbol = $1',
        [symbol],
    );

    return result.rows[0]?.total as number;
}

describe('ingesting bars from a venue built for another market', () => {
    beforeEach(async () => {
        await truncateSignalTables();
    });

    it('refuses to write them under a key that names a different symbol', async () => {
        // The venue is a BTC one. The key says ETH. Writing what the venue
        // returned under the ETH key would produce a chart of BTC that passes
        // every validation in the pipeline, because every one of them is about
        // candle shape and none is about which market the bar came from.
        const provider = venue('BTCUSDT', rollingWindow());

        await expect(
            ingestOnce({
                key: ETH,
                intervalMs: HOUR,
                now: () => AT,
                repository: createCandleRepository(),
                provider,
            }),
        ).rejects.toThrow(/BTCUSDT/);

        expect(await countFor('ETHUSDT')).toBe(0);
        expect(await countFor('BTCUSDT')).toBe(0);
    });

    it('does not spend the request on a write it is going to refuse', async () => {
        const provider = venue('BTCUSDT', rollingWindow());

        await expect(
            ingestOnce({
                key: ETH,
                intervalMs: HOUR,
                now: () => AT,
                repository: createCandleRepository(),
                provider,
            }),
        ).rejects.toThrow();

        // The refusal is decided from what the provider says about itself, so
        // the network call never happens. A guard that ran after the fetch
        // would still be correct and would still cost a round trip per cycle,
        // forever, for an answer that is already known.
        expect(provider.calls).toBe(0);
    });

    it('says which symbol the venue serves, not merely that something differs', async () => {
        // A message naming the expected series but not the venue that answered
        // sends the reader to the scheduler. One naming both sends them to the
        // wiring, which is where the fault is.
        const provider = venue('BTCUSDT', rollingWindow());

        await expect(
            ingestOnce({
                key: ETH,
                intervalMs: HOUR,
                now: () => AT,
                repository: createCandleRepository(),
                provider,
            }),
        ).rejects.toThrow(/serves BTCUSDT.*ETHUSDT/);
    });

    it('still ingests when the venue and the key name the same symbol', async () => {
        // The control. A guard that refuses everything would satisfy the three
        // tests above and stop the service filling its candle table.
        const provider = venue('BTCUSDT', rollingWindow());

        const result = await ingestOnce({
            key: BTC,
            intervalMs: HOUR,
            now: () => AT,
            repository: createCandleRepository(),
            provider,
        });

        expect(provider.calls).toBe(1);
        expect(result.written).toBeGreaterThan(0);
        expect(await countFor('BTCUSDT')).toBeGreaterThan(0);
        expect(await countFor('ETHUSDT')).toBe(0);
    });
});
