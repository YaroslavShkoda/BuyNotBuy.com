import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => ({
    mockAnyProviderAvailable: vi.fn(() => true),
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async (_limit?: number) => [] as unknown[]),
        /**
         * The attributed call the snapshot path actually makes, delegating to
         * the same stub as `getCandles` so every existing arrangement and
         * assertion keeps working while the envelope is exercised for real.
         */
        getAttributedCandles: vi.fn(async (limit?: number) => ({
            venue: 'binance',
            symbol: 'BTCUSDT',
            candles: (await mockMarketDataProvider.getCandles(limit)) as Candle[],
        })),
    },
}));

vi.mock('./market.provider.js', () => ({
    marketDataProvider: mockMarketDataProvider,
    // The freshness model asks whether a live price is obtainable even when the
    // cache answers, because a cache hit means nobody asked anybody. Stubbed
    // separately from the provider so a test can make the feed dead without
    // making the fetch throw.
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    requestedMarketSymbol: vi.fn(() => 'BTCUSDT'),
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

const HOUR_MS = 3_600_000;

function candle(close: number, timestamp: number): Candle {
    return {
        timestamp,
        open: close,
        high: close + 1000,
        low: close - 1000,
        close,
        volume: 100,
    };
}

/**
 * Builds an oldest-first series whose newest bar is the last closed hour.
 *
 * The timestamps have to be real. The series validator now checks the spacing
 * between bars and how recent the newest one is, because a provider that has
 * stopped updating produces a well-formed signal about a market that moved on
 * — and a fixture that answered with bars labelled 1, 2 and 3 would fail those
 * checks for reasons that have nothing to do with what each test is about.
 *
 * Anchored to the clock rather than to a constant, so the fixture stays a
 * stand-in for a venue that answers now.
 */
function series(closes: number[]): Candle[] {
    const newestOpen = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const start = newestOpen - Math.max(0, closes.length - 1) * HOUR_MS;

    return closes.map((close, index) => candle(close, start + index * HOUR_MS));
}

function expectedMarketData(candles: Candle[], price: number) {
    return {
        data: {
            price: {
                symbol: 'BTCUSDT',
                price,
            },
            candles,
            provider: 'binance',
            symbol: 'BTCUSDT',
            interval: marketConfig.candleInterval,
            timestamp: (candles.at(-1)?.timestamp ?? 0) + HOUR_MS,
        },
        stale: false,
        ageMs: 0,
        provider: 'binance',
        freshness: 'fresh',
    };
}

describe('market.service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAnyProviderAvailable.mockReturnValue(true);
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
        const candles = series([80000, 81500]);

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
        mockMarketDataProvider.getCandles.mockResolvedValueOnce(series([80000]));

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
        const closed = series(
            Array.from({ length: requiredCandleCount() }, () => 80_000),
        );

        mockMarketDataProvider.getCandles.mockResolvedValueOnce(closed);

        const { data } = await getMarketData();

        expect(data.candles).toHaveLength(requiredCandleCount());
        expect(data.price.price).toBe(80_000);
    });

    it('getMarketData() deduplicates concurrent calls into one provider request', async () => {
        const candles = series([80000]);

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
        const candles = series([80000]);

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
            const candles = series([80000]);

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
                    .mockResolvedValueOnce(series([80000]))
                    .mockResolvedValueOnce(series([81000]));

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
                const candles = series([80000]);

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
                mockMarketDataProvider.getCandles.mockResolvedValueOnce(
                    series([80000]),
                );

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
                const candles = series([80000]);

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
            const candles = series([80000]);

            mockMarketDataProvider.getCandles.mockResolvedValue(candles);

            const results = await Promise.all(
                Array.from({ length: 10 }, () => getMarketData()),
            );

            expect(
                results.every((result) => result.stale === false),
            ).toBe(true);
            expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
        });

        it('calls a cached snapshot fresh even when every venue is dead', async () => {
            vi.useFakeTimers({
                toFake: ['Date'],
                now: new Date('2026-02-01T00:00:00Z'),
            });

            try {
                // A full warm-up window, not a one-bar stub: a snapshot that
                // cannot support a signal is `partially_available` whatever the
                // venues are doing, and that would mask the state under test.
                const candles = series(
                    Array.from({ length: requiredCandleCount() }, () => 80000),
                );

                mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

                const first = await getMarketData();

                // Both venues are now refusing. A cache hit means nobody was
                // asked, so the only way to know the feed is dead is to look —
                // and without that look the dashboard serves a good snapshot
                // with `X-Data-Stale: false` for as long as the outage lasts,
                // which is precisely the failure that goes unnoticed for an hour.
                mockAnyProviderAvailable.mockReturnValue(false);

                const second = await getMarketData();

                expect(first.freshness).toBe('fresh');
                expect(second.freshness).toBe('provider_failed');
                expect(second.stale).toBe(true);
                expect(second.data).toBe(first.data);
                expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps calling a cached snapshot fresh while a backup is still up', async () => {
            vi.useFakeTimers({
                toFake: ['Date'],
                now: new Date('2026-02-01T00:00:00Z'),
            });

            try {
                mockMarketDataProvider.getCandles.mockResolvedValueOnce(
                    series(
                        Array.from({ length: requiredCandleCount() }, () => 80000),
                    ),
                );

                await getMarketData();

                // The primary is gone but the backup is not: the answer is
                // still a live one, and reporting `provider_failed` here would
                // cry wolf on every failover the site handles by design.
                mockAnyProviderAvailable.mockReturnValue(true);

                const again = await getMarketData();

                expect(again.freshness).toBe('fresh');
                expect(again.stale).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('snapshot attribution', () => {
        it('records the venue that actually answered', async () => {
            mockMarketDataProvider.getAttributedCandles.mockResolvedValueOnce({
                venue: 'bitget',
                symbol: 'BTCUSDT',
                candles: series([80000]),
            });

            const result = await getMarketData();

            // The two venues print different numbers for the same hour, so a
            // failover that is not labelled is a fake market move in every
            // chart and every stored snapshot.
            expect(result.provider).toBe('bitget');
            expect(result.data.provider).toBe('bitget');
        });

        it('stamps the market clock, not the fetch clock', async () => {
            const candles = series([80000, 81500]);

            mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

            const { data } = await getMarketData();

            // "When we looked" and "what the market did" are different facts,
            // and only the second one belongs in a record meant to be replayed.
            expect(data.timestamp).toBe(
                (candles.at(-1)?.timestamp ?? 0) + marketConfig.candleIntervalMs,
            );
        });

        it('refuses a venue that answers with a different symbol', async () => {
            // A fallback configured for another pair is a legitimate setting;
            // publishing its price under the primary's ticker is not.
            mockMarketDataProvider.getAttributedCandles.mockResolvedValueOnce({
                venue: 'bitget',
                symbol: 'ETHUSDT',
                candles: series([3000]),
            });

            const error = await getMarketData().catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(MarketDataError);
            expect((error as MarketDataError).code).toBe('MARKET_PROVIDER_ERROR');
            expect((error as MarketDataError).cause).toMatchObject({
                provider: 'bitget',
                requestedSymbol: 'BTCUSDT',
                answeredSymbol: 'ETHUSDT',
            });
        });
    });
});
