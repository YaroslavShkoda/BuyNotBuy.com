import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async () => [] as unknown[]),
    },
}));

vi.mock('./market.provider.js', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

import {
    getMarketData,
    getPrice,
    resetMarketDataCache,
} from './market.service.js';

import { marketConfig } from '../config/market.config.js';
import { requiredCandleCount } from '../config/indicator.config.js';
import { MAX_CANDLE_LIMIT } from '../config/market.config.js';
import { MarketDataError } from '../errors/market-data.error.js';

import type { Candle } from '../types/market.js';

function candle(close: number, timestamp = 1): Candle {
    return {
        timestamp,
        open: close,
        high: close + 1000,
        low: close - 1000,
        close,
        volume: 100,
    };
}

function expectedMarketData(candles: Candle[], price: number) {
    return {
        data: {
            price: {
                symbol: 'BTCUSDT',
                price,
            },
            candles,
        },
        stale: false,
        ageMs: 0,
    };
}

describe('market.service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The snapshot cache is process-wide by design; without a reset a
        // snapshot from one test would satisfy the next one and hide the
        // behaviour under test.
        resetMarketDataCache();
    });

    it('getPrice() delegates to provider.getPrice() without loading candles', async () => {
        const price = {
            symbol: 'BTCUSDT',
            price: 81246.5,
        };

        mockMarketDataProvider.getPrice.mockResolvedValueOnce(price);

        const result = await getPrice();

        expect(result).toEqual(price);

        expect(mockMarketDataProvider.getPrice).toHaveBeenCalledTimes(1);
        expect(mockMarketDataProvider.getCandles).not.toHaveBeenCalled();
    });

    it('getMarketData() returns the last closed close as the price', async () => {
        const candles = [candle(80000, 1), candle(81500, 2)];

        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        const result = await getMarketData();

        // The dashboard is a snapshot of the last closed hour, so the price
        // comes from that candle instead of a live ticker call: the signal,
        // the chart and the "price above/below EMA" reading must all share one
        // time base.
        expect(result).toEqual(expectedMarketData(candles, 81500));

        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
        expect(mockMarketDataProvider.getPrice).not.toHaveBeenCalled();
    });

    it('getMarketData() asks the provider for a warm-up window plus the forming bar', async () => {
        mockMarketDataProvider.getCandles.mockResolvedValueOnce([candle(80000)]);

        await getMarketData();

        // The provider layer drops the still-forming last bar, so the request
        // has to be one bar larger than the warm-up needs. Asking for exactly
        // `requiredCandleCount()` arrives one short and fails the guard.
        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledWith(
            requiredCandleCount() + 1,
        );

        // The warm-up must fit inside a single Binance klines request.
        expect(requiredCandleCount() + 1).toBeLessThanOrEqual(MAX_CANDLE_LIMIT);
    });

    it('getMarketData() survives a response whose last bar is still forming', async () => {
        const closed = Array.from(
            { length: requiredCandleCount() },
            (_, index) => candle(80_000, index),
        );

        mockMarketDataProvider.getCandles.mockResolvedValueOnce(closed);

        const { data } = await getMarketData();

        expect(data.candles).toHaveLength(requiredCandleCount());
        expect(data.price.price).toBe(80_000);
    });

    it('getMarketData() deduplicates concurrent calls into one provider request', async () => {
        const candles = [candle(80000)];

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        mockMarketDataProvider.getCandles.mockImplementationOnce(async () => {
            await gate;
            return candles;
        });

        const first = getMarketData();
        const second = getMarketData();

        release();

        const expected = expectedMarketData(candles, 80000);

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toEqual(expected);
        expect(secondResult).toEqual(expected);

        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
    });

    it('getMarketData() does not share a failed request with the next call', async () => {
        const candles = [candle(80000)];

        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new MarketDataError('upstream failed'),
        );

        await expect(getMarketData()).rejects.toBeInstanceOf(MarketDataError);

        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        const result = await getMarketData();

        expect(result).toEqual(expectedMarketData(candles, 80000));
        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(2);
    });

    it('getMarketData() rejects empty candles with a normalized error', async () => {
        mockMarketDataProvider.getCandles.mockResolvedValueOnce([]);

        const error = await getMarketData().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error).toMatchObject({
            name: 'MarketDataError',
            code: 'MARKET_PROVIDER_ERROR',
            statusCode: 502,
        });
    });

    describe('snapshot cache', () => {
        it('serves a second call inside the TTL without touching the provider', async () => {
            const candles = [candle(80000)];

            mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

            const first = await getMarketData();
            const second = await getMarketData();

            expect(second.data).toBe(first.data);
            expect(second.stale).toBe(false);
            expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
        });

        it('refetches once the TTL has passed', async () => {
            vi.useFakeTimers({
                toFake: ['Date'],
                now: new Date('2026-02-01T00:00:00Z'),
            });

            try {
                mockMarketDataProvider.getCandles
                    .mockResolvedValueOnce([candle(80000)])
                    .mockResolvedValueOnce([candle(81000)]);

                await getMarketData();

                vi.advanceTimersByTime(
                    marketConfig.cacheTtlMs + 1,
                );

                const refreshed = await getMarketData();

                expect(refreshed.data.price.price).toBe(81000);
                expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it('serves the last good snapshot when the provider starts failing', async () => {
            vi.useFakeTimers({
                toFake: ['Date'],
                now: new Date('2026-02-01T00:00:00Z'),
            });

            try {
                const candles = [candle(80000)];

                mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

                await getMarketData();

                // Past the TTL the provider is contacted again and fails.
                vi.advanceTimersByTime(
                    marketConfig.cacheTtlMs + 1,
                );

                mockMarketDataProvider.getCandles.mockRejectedValueOnce(
                    new MarketDataError('upstream unavailable'),
                );

                const degraded = await getMarketData();

                expect(degraded.stale).toBe(true);
                expect(degraded.data.candles).toEqual(candles);
                expect(degraded.ageMs).toBeGreaterThan(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it('still fails when the fallback snapshot is older than maxStaleMs', async () => {
            vi.useFakeTimers({
                toFake: ['Date'],
                now: new Date('2026-02-01T00:00:00Z'),
            });

            try {
                mockMarketDataProvider.getCandles.mockResolvedValueOnce([
                    candle(80000),
                ]);

                await getMarketData();

                // A snapshot from last week is not a substitute for a live
                // reading, so the error is reported instead.
                vi.advanceTimersByTime(
                    marketConfig.maxStaleMs + 1,
                );

                mockMarketDataProvider.getCandles.mockRejectedValueOnce(
                    new MarketDataError('upstream unavailable'),
                );

                await expect(getMarketData()).rejects.toBeInstanceOf(
                    MarketDataError,
                );
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps a fresh snapshot even while the provider is down', async () => {
            vi.useFakeTimers({
                toFake: ['Date'],
                now: new Date('2026-02-01T00:00:00Z'),
            });

            try {
                const candles = [candle(80000)];

                mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

                await getMarketData();

                // Inside the TTL the provider is not consulted at all, so a
                // provider outage cannot turn into a user-visible error.
                const again = await getMarketData();

                expect(again.stale).toBe(false);
                expect(again.data.candles).toEqual(candles);
            } finally {
                vi.useRealTimers();
            }
        });

        it('serves exactly one snapshot for a concurrent burst', async () => {
            const candles = [candle(80000)];

            mockMarketDataProvider.getCandles.mockResolvedValue(candles);

            const results = await Promise.all(
                Array.from({ length: 10 }, () => getMarketData()),
            );

            expect(
                results.every((result) => result.stale === false),
            ).toBe(true);
            expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
        });
    });
});
