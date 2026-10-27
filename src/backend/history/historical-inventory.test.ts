import { describe, expect, it } from 'vitest';
import { getTestPool } from '../test-support/test-database.js';
import { createCandleRepository } from './candle.repository.js';
import { inventoryHistoricalIntegrity } from './historical-inventory.js';

const start = 1_699_999_200_000;
describe('read-only historical inventory evidence', () => {
    it('includes empty declared series and detects gaps without modifying rows', async () => {
        const repository = createCandleRepository();
        const key = { provider: 'binance', symbol: 'BTCUSDT', interval: '1h' as const };
        for (const timestamp of [start, start + 7_200_000]) {
            await repository.upsert(key, { timestamp, open: 100, high: 101, low: 99, close: 100, volume: 10 });
        }
        await repository.upsert(key, { timestamp: start + 10_800_000, open: 100, high: 101, low: 99, close: 100, volume: 10 }, { isClosed: false });
        const before = await getTestPool().query('SELECT * FROM market_candles ORDER BY timestamp');
        const report = await inventoryHistoricalIntegrity({ now: start + 10_800_000, from: start, to: start + 7_200_000 }, [{ venue: 'binance', instruments: ['BTCUSDT', 'ETHUSDT'], intervals: ['1h'] }]);
        expect(report.activationAllowed).toBe(false);
        expect(report.independentSourceVerification).toBe('NOT_TESTED');
        expect(report.series[0]?.blockers).toEqual(expect.arrayContaining(['timestamp_gap', 'provenance_unknown']));
        expect(report.series[0]?.inventory).toMatchObject({ count: 3, closedCount: 2, newest: start + 7_200_000 });
        expect(report.series[1]?.blockers).toContain('empty_series');
        expect((await getTestPool().query('SELECT * FROM market_candles ORDER BY timestamp')).rows).toEqual(before.rows);
    });
    it('reports undeclared physical series instead of silently omitting them', async () => {
        await createCandleRepository().upsert({ provider: 'bitget', symbol: 'ETHUSDT', interval: '1h' }, { timestamp: start, open: 100, high: 101, low: 99, close: 100, volume: 10 });
        const report = await inventoryHistoricalIntegrity({ now: start + 3_600_000, from: start, to: start }, [{ venue: 'binance', instruments: ['BTCUSDT'], intervals: ['1h'] }]);
        expect(report.undeclared).toEqual([expect.objectContaining({ provider: 'bitget', symbol: 'ETHUSDT', count: 1 })]);
        expect(report.activationAllowed).toBe(false);
    });
});
