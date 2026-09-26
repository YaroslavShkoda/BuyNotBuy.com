import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({ symbol: 'BTCUSDT', price: 80000 })),
        getCandles: vi.fn(async (limit = 900) =>
            Array.from({ length: Math.max(0, limit - 1) }, (_, index) => ({
                timestamp: Date.now() - (limit - 1 - index) * 3_600_000,
                open: 100 + index,
                high: 102 + index,
                low: 98 + index,
                close: 100 + index,
                volume: 1000,
            })),
        ),
    },
}));

vi.mock('./market.provider.js', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

import { assertCandleSeries } from './candle-validation.js';
import { getMarketData, resetMarketDataCache } from './market.service.js';

import type { Candle } from '../types/market.js';

const HOUR_MS = 3_600_000;
const NOW = Date.now();

function healthy(count: number): Candle[] {
    return Array.from({ length: count }, (_, index) => ({
        timestamp: NOW - (count - index) * HOUR_MS,
        open: 100 + index,
        high: 102 + index,
        low: 98 + index,
        close: 100 + index,
        volume: 1000,
    }));
}

afterEach(() => {
    vi.clearAllMocks();
    resetMarketDataCache();
});

describe('market layer rejects a broken series before it reaches the indicators', () => {
    it('reports the issue as a provider failure, not an internal error', async () => {
        resetMarketDataCache();

        mockMarketDataProvider.getCandles.mockResolvedValueOnce([
            ...healthy(3).slice(0, 2),
            // A close above the high: a range the market could not have made.
            {
                timestamp: NOW - HOUR_MS,
                open: 100,
                high: 110,
                low: 90,
                close: 999,
                volume: 1000,
            },
        ]);

        const error = await getMarketData().catch((e: unknown) => e);

        // If this slipped through, the dashboard would publish a signal built
        // on a bar that cannot exist, and nothing downstream would notice.
        expect(error).toMatchObject({
            code: 'MARKET_PROVIDER_ERROR',
            statusCode: 502,
        });
        expect((error as { cause: { issue: string } }).cause.issue).toBe(
            'ohlc_inconsistent',
        );
    });

    it('reports an out-of-order series instead of averaging it away', async () => {
        resetMarketDataCache();

        const shuffled = healthy(3);
        const swapped = [
            shuffled[0] as Candle,
            shuffled[2] as Candle,
            shuffled[1] as Candle,
        ];

        mockMarketDataProvider.getCandles.mockResolvedValueOnce(swapped);

        const error = await getMarketData().catch((e: unknown) => e);

        expect((error as { cause: { issue: string } }).cause.issue).toBe(
            'not_increasing',
        );
    });

    it('reports a duplicated bar', async () => {
        resetMarketDataCache();

        const candles = healthy(3);
        mockMarketDataProvider.getCandles.mockResolvedValueOnce([
            candles[0] as Candle,
            candles[0] as Candle,
            candles[1] as Candle,
        ]);

        const error = await getMarketData().catch((e: unknown) => e);

        expect((error as { cause: { issue: string } }).cause.issue).toBe(
            'duplicate',
        );
    });

    it('lets a well-formed series through untouched', async () => {
        resetMarketDataCache();

        const candles = healthy(900);
        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        const result = await getMarketData();

        expect(result.stale).toBe(false);
        expect(result.data.candles).toHaveLength(900);
        expect(result.data.price.price).toBe(100 + 899);
    });

    it('checks the same invariants regardless of which provider is configured', () => {
        expect(() => assertCandleSeries(healthy(3), NOW, 'mock')).not.toThrow();
        expect(() => assertCandleSeries([], NOW, 'mock')).toThrow();
    });
});
