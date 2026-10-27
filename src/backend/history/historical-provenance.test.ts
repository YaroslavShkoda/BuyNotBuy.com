import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailoverProvider } from '../market/failover.provider.js';
import type { MarketDataProvider, ProviderCandles } from '../market/providers/market-data.provider.js';
import { currentRegistry, useRegistry } from '../observability/registry.js';
import { getTestPool } from '../test-support/test-database.js';
import { runBackfill } from './backfill.service.js';
import { createCandleRepository } from './candle.repository.js';
import { ingestOnce } from './ingestion.service.js';

const at = 1_699_999_200_000;
const candle = { timestamp: at - 3_600_000, open: 100, high: 101, low: 99, close: 100, volume: 10 };
const key = { provider: 'binance', symbol: 'ETHUSDT', interval: '1h' as const };
function provider(envelope: Partial<ProviderCandles> = {}): MarketDataProvider {
    return { name: 'binance', symbol: 'ETHUSDT', getPrice: async () => ({ symbol: 'ETHUSDT', price: 100 }),
        getCandles: async () => [candle], getHistoricalCandles: async () => [candle],
        getAttributedCandles: async () => ({ venue: 'binance', symbol: 'ETHUSDT', interval: '1h', candles: [candle] }),
        getAttributedHistoricalCandles: async () => ({ venue: 'binance', symbol: 'ETHUSDT', interval: '1h', candles: [candle], ...envelope }),
    };
}
afterEach(() => useRegistry(null));
describe('historical response provenance', () => {
    it.each([
        [{ venue: 'bitget' }, 'venue_mismatch'], [{ symbol: 'BTCUSDT' }, 'symbol_mismatch'],
        [{ interval: '15m' as const }, 'interval_mismatch'],
    ])('rejects wrong response %j before either writer touches storage', async (envelope, reason) => {
        for (const operation of ['ingestion', 'backfill'] as const) {
            const request = { key, provider: provider(envelope), repository: createCandleRepository(), now: () => at, intervalMs: 3_600_000, maxCandles: 1 };
            await expect(operation === 'ingestion' ? ingestOnce(request) : runBackfill(request)).rejects.toThrow(reason);
        }
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
        expect(currentRegistry().render()).toContain(`reason="${reason}"`);
    });
    it('runs BTC and ETH ingestion/backfill concurrently and repeats writes across restart', async () => {
        const run = async (symbol: string, mode: 'ingest' | 'backfill', timestamp: number) => {
            const close = symbol === 'BTCUSDT' ? 10_000 : 100;
            const source = { ...provider({ symbol, candles: [{ ...candle, timestamp, open: close, high: close + 1, low: close - 1, close }] }), symbol };
            const request = { key: { ...key, symbol }, provider: source, repository: createCandleRepository(), now: () => at, intervalMs: 3_600_000, until: timestamp, maxCandles: 1 };
            return mode === 'ingest' ? ingestOnce(request) : runBackfill(request);
        };
        for (let bar = 0; bar < 16; bar += 1) {
            const timestamp = candle.timestamp - bar * 3_600_000;
            for (let restart = 0; restart < 2; restart += 1) {
                await Promise.all(['BTCUSDT', 'ETHUSDT'].flatMap((symbol) => [run(symbol, 'ingest', timestamp), run(symbol, 'backfill', timestamp)]));
            }
        }
        const rows = await getTestPool().query('SELECT symbol, count(*)::int AS n FROM market_candles GROUP BY symbol ORDER BY symbol');
        expect(rows.rows).toEqual([{ symbol: 'BTCUSDT', n: 16 }, { symbol: 'ETHUSDT', n: 16 }]);
        const values = await getTestPool().query('SELECT symbol, min(close) AS low, max(close) AS high FROM market_candles GROUP BY symbol ORDER BY symbol');
        expect(values.rows).toEqual([{ symbol: 'BTCUSDT', low: 10_000, high: 10_000 }, { symbol: 'ETHUSDT', low: 100, high: 100 }]);
    });
    it('keeps fallback physical venue in the response and refuses to relabel it as primary', async () => {
        const primary = { ...provider(), getAttributedHistoricalCandles: async () => { throw new Error('offline'); } };
        const backup = { ...provider({ venue: 'bitget' }), name: 'bitget' };
        const chain = new FailoverProvider({ name: 'binance', provider: primary }, [{ name: 'bitget', provider: backup }]);
        expect((await chain.getAttributedHistoricalCandles(1)).venue).toBe('bitget');
        await expect(ingestOnce({ key, provider: chain, intervalMs: 3_600_000, now: () => at })).rejects.toThrow('venue_mismatch');
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
    });
    it('rejects a backup envelope that impersonates the primary venue', async () => {
        const primary = { ...provider(), getAttributedHistoricalCandles: async () => { throw new Error('offline'); } };
        const backup = { ...provider({ venue: 'binance' }), name: 'bitget' };
        const chain = new FailoverProvider({ name: 'binance', provider: primary }, [{ name: 'bitget', provider: backup }]);
        await expect(ingestOnce({ key, provider: chain, intervalMs: 3_600_000, now: () => at })).rejects.toThrow('venue_mismatch');
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
    });
    it('refuses unavailable historical provenance before fetching bare candles', async () => {
        const bare = provider();
        delete bare.getAttributedHistoricalCandles;
        bare.getHistoricalCandles = vi.fn(async () => [candle]);
        await expect(ingestOnce({ key, provider: bare, intervalMs: 3_600_000, now: () => at })).rejects.toThrow('provenance_unavailable');
        await expect(runBackfill({ key, provider: bare, maxCandles: 1, now: () => at })).rejects.toThrow('provenance_unavailable');
        expect(bare.getHistoricalCandles).not.toHaveBeenCalled();
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
    });
    it.each([-3_600_000, candle.timestamp + 1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timestamp %s atomically before either writer', async (timestamp) => {
        for (const operation of ['ingestion', 'backfill'] as const) {
            const request = { key, provider: provider({ candles: [candle, { ...candle, timestamp }] }), now: () => at, intervalMs: 3_600_000, until: 0, maxCandles: 2 };
            await expect(operation === 'ingestion' ? ingestOnce(request) : runBackfill(request)).rejects.toThrow('timestamp_invalid');
        }
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
    });
    it('rejects a caller interval duration inconsistent with its series key', async () => {
        await expect(ingestOnce({ key, provider: provider(), intervalMs: 900_000, now: () => at })).rejects.toThrow('interval_mismatch');
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
    });
    it('never stores a forming backfill candle as closed', async () => {
        await expect(runBackfill({ key, provider: provider({ candles: [{ ...candle, timestamp: at }] }), maxCandles: 1, now: () => at + 1_800_000 })).rejects.toThrow('candle_not_closed');
        expect((await getTestPool().query('SELECT count(*)::int AS n FROM market_candles')).rows[0].n).toBe(0);
    });
});
