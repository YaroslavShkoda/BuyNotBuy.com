import { describe, expect, it } from 'vitest';
import { seedTestInstrument } from '../test-support/test-database.js';
import type { Candle } from '../types/market.js';
import { runBackfill } from './backfill.service.js';
import { createCandleRepository } from './candle.repository.js';

const DAY = 86_400_000;
const BASE = 1_600_000_000_000;

const bar = (i: number): Candle => ({
    timestamp: BASE + (2 - i) * DAY,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 10,
});

/**
 * The overwrite count has to be a measurement, not a decoration.
 *
 * My first version asked `getRange(key, bars[0].timestamp,
 * bars.at(-1).timestamp)`. A backfill walks backwards, so a page arrives
 * **newest-first** and that range is inverted: the query returned nothing, the
 * overlap came back as zero, and the report cheerfully said "0 overwritten"
 * over three bars it had just replaced. A live run with an overlap I had
 * described but not built is what caught it — the first two attempts reported
 * zero because the data genuinely had no overlap, and only the third, with a
 * real one, showed the number never moved.
 *
 * A counter that reads zero when the thing it measures happened is worse than
 * no counter, because it is believed.
 */
describe('the backfill counts what it overwrote', () => {
    it('separates filling a gap from replacing a stored bar', async () => {
        const symbol = `BF${Date.now().toString(36).toUpperCase()}USDT`;
        const key = { provider: 'test', symbol, interval: '1d' };
        const repository = createCandleRepository();

        await seedTestInstrument(symbol);

        // Three bars already stored: indices 0, 1, 2.
        await repository.bulkUpsert(key, [bar(0), bar(1), bar(2)]);

        // The venue hands back those three again, plus three older ones.
        const page = [bar(0), bar(1), bar(2), bar(3), bar(4), bar(5)];
        const provider = {
            getHistoricalCandles: async () => page,
            getAttributedCandles: async () => ({
                venue: 'test',
                symbol,
                candles: page,
            }),
        };

        const result = await runBackfill({
            key,
            maxCandles: 6,
            until: BASE - 4 * DAY,
            repository,
            provider: provider as never,
            now: () => BASE + 10 * DAY,
            sleep: async () => undefined,
        });

        expect(result.written).toBe(6);
        expect(result.overwritten).toBe(3);
        expect(result.written - result.overwritten).toBe(3);
    }, 30_000);

    it('reports zero when the run only fills gaps', async () => {
        const symbol = `BG${Date.now().toString(36).toUpperCase()}USDT`;
        const key = { provider: 'test', symbol, interval: '1d' };
        const repository = createCandleRepository();

        await seedTestInstrument(symbol);

        await repository.bulkUpsert(key, [bar(0), bar(1), bar(2)]);

        // Strictly older than anything stored: a pure gap fill.
        const page = [bar(3), bar(4), bar(5)];
        const provider = {
            getHistoricalCandles: async () => page,
            getAttributedCandles: async () => ({
                venue: 'test',
                symbol,
                candles: page,
            }),
        };

        const result = await runBackfill({
            key,
            maxCandles: 3,
            until: BASE - 4 * DAY,
            repository,
            provider: provider as never,
            now: () => BASE + 10 * DAY,
            sleep: async () => undefined,
        });

        expect(result.written).toBe(3);
        expect(result.overwritten).toBe(0);
    }, 30_000);

    it('never reports more overwritten than written', async () => {
        const symbol = `BH${Date.now().toString(36).toUpperCase()}USDT`;
        const key = { provider: 'test', symbol, interval: '1d' };
        const repository = createCandleRepository();

        await seedTestInstrument(symbol);
        const provider = {
            getHistoricalCandles: async () => [],
            getAttributedCandles: async () => ({
                venue: 'test',
                symbol,
                candles: [],
            }),
        };

        const result = await runBackfill({
            key,
            maxCandles: 5,
            until: BASE,
            repository,
            provider: provider as never,
            now: () => BASE + 10 * DAY,
            sleep: async () => undefined,
        });

        expect(result.overwritten).toBeLessThanOrEqual(result.written);
        expect(result.written).toBe(0);
    }, 30_000);
});
