import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => ({
    mockAnyProviderAvailable: vi.fn(() => true),
    mockMarketDataProvider: {
        // Set by the router below to whatever market was asked for, so the
        // provider reports the market it is serving rather than a fixed one.
        symbol: 'BTCUSDT',
        getPrice: vi.fn(async () => ({
            symbol: mockMarketDataProvider.symbol,
            price: 80000,
        })),
        getCandles: vi.fn(async (_limit?: number) => [] as unknown[]),
        getAttributedCandles: vi.fn(async (limit?: number) => ({
            venue: 'binance',
            symbol: mockMarketDataProvider.symbol,
            candles: (await mockMarketDataProvider.getCandles(limit)) as Candle[],
        })),
    },
}));

vi.mock('./market.provider.js', () => ({
    // The router hands the service a provider for the market it was asked
    // about. Every test here has one market, so it hands back the one stub —
    // the routing itself is exercised in capability.test.ts, where a wrong
    // answer is a property failure rather than a mistyped URL.
    marketProviderFor: (instrument: string) => {
        // **Per market, and it is what makes the second test possible.** The stub
        // used to answer `BTCUSDT` for every request, so a two-market test could
        // not be written: `fetchMarketData` compares the symbol it was handed
        // against the request and refuses a mismatch, correctly. A mock that
        // cannot answer the question is not a simplification, it is a wall.
        mockMarketDataProvider.symbol = instrument;

        return mockMarketDataProvider;
    },
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

        // **And the same metric, per market, in the same scrape.** The totals
        // above are the contract: a reader asking for these names by name keeps
        // getting a number. Labelling the counter instead would have made every
        // one of those readers silently read 0 — the failure that already cost
        // \ its readers once, for exactly this reason.
        //
        // So the breakdown is an *additional* series on the same metric, and this
        // asserts both halves are in one document: a dashboard can now say which
        // market is missing on every request, and the ratio still works.
        expect(rendered).toMatch(/buynotbuy_market_cache_hits\{market="BTCUSDT"\} 1/);
        expect(rendered).toMatch(/buynotbuy_market_cache_misses\{market="BTCUSDT"\} 1/);
    });

    it('splits the same metric by market when two are running', async () => {
        // One flat number cannot say that BTCUSDT is answered from cache every
        // time while ETHUSDT is never cached at all — which is a real
        // misconfiguration wearing the shape of healthy traffic.
        mockMarketDataProvider.getCandles.mockResolvedValue(series(Array.from({ length: 100 }, (_, i) => 50000 + i)));

        await getMarketData();
        await getMarketData();
        await getMarketData({ instrument: 'ETHUSDT', interval: marketConfig.candleInterval });
        await getMarketData({ instrument: 'ETHUSDT', interval: marketConfig.candleInterval });

        // One miss each: the two markets miss once and then hit, and the total is
        // the sum of both.
        expect(registry.value('market_cache_misses')).toBe(2);
        expect(registry.value('market_cache_misses', { market: 'BTCUSDT' })).toBe(1);
        expect(registry.value('market_cache_misses', { market: 'ETHUSDT' })).toBe(1);
        expect(registry.value('market_cache_hits', { market: 'BTCUSDT' })).toBe(1);
        expect(registry.value('market_cache_hits', { market: 'ETHUSDT' })).toBe(1);
    });
});
