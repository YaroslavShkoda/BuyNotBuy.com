import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => ({
    mockAnyProviderAvailable: vi.fn(() => true),
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({ symbol: 'BTCUSDT', price: 80000 })),
        getCandles: vi.fn(async (_limit?: number) => [] as unknown[]),
        getAttributedCandles: vi.fn(async (limit?: number) => ({
            venue: 'binance',
            symbol: 'BTCUSDT',
            candles: (await mockMarketDataProvider.getCandles(limit)) as Candle[],
        })),
    },
}));

vi.mock('./market.provider.js', () => ({
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    requestedMarketSymbol: vi.fn(() => 'BTCUSDT'),
}));

import { getMarketData, resetMarketDataCache } from './market.service.js';
import { marketConfig } from '../config/market.config.js';
import { MetricRegistry, useRegistry } from '../observability/registry.js';

import type { Candle } from '../types/market.js';

const HOUR_MS = 3_600_000;

/**
 * A series whose newest bar is the last closed hour, so the freshness and
 * series checks accept it. The counter is the cheap half; what these tests are
 * for is whether the increment sits on the path the system really takes. A test
 * that called the increment directly would still pass with the cache branch
 * deleted, and a metric wired to nothing is the failure this project has hit
 * twice already.
 */
function series(closes: number[]): Candle[] {
    const newestOpen = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

    return closes.map((close, index) => ({
        timestamp: newestOpen - (closes.length - 1 - index) * HOUR_MS,
        open: close,
        high: close + 1000,
        low: close - 1000,
        close,
        volume: 100,
    }));
}

describe('the cache counters move only when the cache is consulted', () => {
    let registry: MetricRegistry;

    beforeEach(() => {
        registry = new MetricRegistry();
        useRegistry(registry);
        resetMarketDataCache();
        mockAnyProviderAvailable.mockReturnValue(true);
    });

    afterEach(() => {
        useRegistry(null);
        resetMarketDataCache();
    });

    it('counts a miss on the first call and a hit on every call after it', async () => {
        mockMarketDataProvider.getCandles.mockResolvedValue(series(Array.from({ length: 100 }, (_, i) => 50000 + i)));

        await getMarketData();
        await getMarketData();
        await getMarketData();

        expect(registry.value('market_cache_misses')).toBe(1);
        expect(registry.value('market_cache_hits')).toBe(2);
    });

    it('counts a miss even when the fetch fails, because the cache did miss', async () => {
        mockMarketDataProvider.getCandles.mockRejectedValue(new Error('provider down'));

        await expect(getMarketData()).rejects.toThrow();
        expect(registry.value('market_cache_misses')).toBe(1);
        expect(registry.value('market_cache_hits')).toBe(0);
    });

    it('does not count a stale answer as served when nothing was served', async () => {
        mockMarketDataProvider.getCandles.mockRejectedValue(new Error('provider down'));

        await expect(getMarketData()).rejects.toThrow();

        // There was no snapshot to serve. Counting this as a stale serve would
        // make an outage that has never produced an answer look like one that
        // has been answering for hours, which is the opposite of the point of
        // the metric.
        expect(registry.value('market_stale_served')).toBe(0);
    });

    it('counts a served stale answer, and only that path', async () => {
        vi.useFakeTimers({
            toFake: ['Date'],
            now: new Date('2026-02-01T00:00:00Z'),
        });

        try {
            mockMarketDataProvider.getCandles.mockResolvedValueOnce(
                series(Array.from({ length: 100 }, (_, i) => 50000 + i)),
            );

            const first = await getMarketData();

            expect(first.stale).toBe(false);
            expect(registry.value('market_stale_served')).toBe(0);

            // Past the TTL the provider is contacted again; past the staleness
            // ceiling the snapshot is refused outright. Somewhere between the
            // two is the only window in which this module can answer at all,
            // and the counter has to move exactly there.
            vi.advanceTimersByTime(marketConfig.cacheTtlMs + 1);
            mockMarketDataProvider.getCandles.mockRejectedValue(new Error('provider down'));
            mockAnyProviderAvailable.mockReturnValue(false);

            const degraded = await getMarketData();

            expect(degraded.stale).toBe(true);
            expect(registry.value('market_stale_served')).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('publishes all three in one scrape, so a graph can show the ratio', async () => {
        mockMarketDataProvider.getCandles.mockResolvedValue(series(Array.from({ length: 100 }, (_, i) => 50000 + i)));

        await getMarketData();
        await getMarketData();

        const rendered = registry.render({ namespace: 'buynotbuy_' });

        expect(rendered).toMatch(/buynotbuy_market_cache_misses 1/);
        expect(rendered).toMatch(/buynotbuy_market_cache_hits 1/);
    });
});
