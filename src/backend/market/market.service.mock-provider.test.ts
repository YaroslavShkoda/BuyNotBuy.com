import { describe, expect, it, vi } from 'vitest';

describe('market.service with MockProvider', () => {
    it('returns market data from MockProvider', async () => {
        vi.resetModules();

        vi.stubEnv('MARKET_PROVIDER', 'mock');

        const {
            getMarketData,
        } = await import('./market.service');

        const { data, stale } = await getMarketData();

        expect(stale).toBe(false);

        expect(data.price).toEqual({
            symbol: 'BTCUSDT',
            price: 100899,
        });

        expect(data.candles).toHaveLength(900);

        // The mock is anchored to the current hour, so the labels move with the
        // clock. What is fixed is the shape and the walk: a straight line of
        // hourly bars, one dollar a bar, which is what makes an assertion
        // against a metric meaningful in the first place.
        expect(data.candles[0]).toEqual({
            timestamp: expect.any(Number),
            open: 99990,
            high: 100010,
            low: 99980,
            close: 100000,
            volume: 1000,
        });

        expect(data.candles[899]?.timestamp).toBe(
            (data.candles[0]?.timestamp ?? 0) + 899 * 60 * 60 * 1000,
        );

        expect(data.candles[899]).toEqual({
            timestamp: expect.any(Number),
            open: 100889,
            high: 100909,
            low: 100879,
            close: 100899,
            volume: 1000,
        });

        // The whole point of re-anchoring: a mock that answers with a series
        // ending in November 2023 is a mock the staleness check rejects, and
        // every test that leans on it would be leaning on a bypass.
        expect(data.candles[899]?.timestamp).toBeGreaterThan(
            Date.now() - 2 * 60 * 60 * 1000,
        );

        vi.unstubAllEnvs();
    });
});
