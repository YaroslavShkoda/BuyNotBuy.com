import { describe, expect, it, beforeEach, vi } from 'vitest';

import { MarketDataError } from './errors/market-data.error.js';
import { marketConfig } from './config/market.config.js';
import { requiredCandleCount } from './config/indicator.config.js';
import { currentCandles } from './test-support/candles.js';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    const base = {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),

        getCandles: vi.fn(
            async (limit = marketConfig.defaultCandleLimit) =>
                currentCandles(limit, 100, 0),
        ),
    };

    return {
        mockAnyProviderAvailable: vi.fn(() => true),
        mockMarketDataProvider: {
            ...base,
            // The attributed call the snapshot path makes, delegating to the
            // same stub so every existing arrangement keeps working while the
            // venue envelope is exercised for real.
            getAttributedCandles: vi.fn(async (limit?: number) => ({
                venue: 'binance',
                symbol: 'BTCUSDT',
                candles: await base.getCandles(limit),
            })),
        },
    };
});

vi.mock('./market/market.provider.js', () => ({
    // The router hands the service a provider for the market it was asked
    // about. Every test here has one market, so it hands back the one stub —
    // the routing itself is exercised in capability.test.ts, where a wrong
    // answer is a property failure rather than a mistyped URL.
    marketProviderFor: () => mockMarketDataProvider,
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    requestedMarketSymbol: vi.fn(() => marketConfig.symbol),
}));

vi.mock('./history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from './app.js';
import { resetMarketDataCache } from './market/market.service.js';

describe('Backend app', () => {
    beforeEach(() => {
        // The market snapshot cache is process-wide; without a reset a healthy
        // response earlier in this file would satisfy the error-path tests and
        // hide the provider failure they are meant to assert.
        resetMarketDataCache();
    });

    it('returns health message from root route', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            message: 'BuyNotBuy backend is running',
        });

        await app.close();
    });

    it('returns price from /api/price', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/price',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            symbol: 'BTCUSDT',
            price: 80000,
        });

        await app.close();
    });

    it('returns market data from /api/market', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/market',
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();

        expect(body.price).toEqual({
            symbol: 'BTCUSDT',
            price: 100,
        });

        expect(body.candles.length).toBeGreaterThanOrEqual(
            requiredCandleCount(),
        );

        await app.close();
    });

    it('returns market analysis from /api/analysis', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();

        expect(body.price).toBe(100);
        expect(body.indicators).toHaveProperty('ema300');
        expect(body.indicators).toHaveProperty('stochastic');
        expect(body.signal).toHaveProperty('signal');
        expect(body.signal).toHaveProperty('confidence');
        expect(body.signal).toHaveProperty('reason');
        expect(body.timestamp).toBeTypeOf('number');

        await app.close();
    });

    it('returns 502 when market data provider fails', async () => {
        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new MarketDataError('Binance API error: 503'),
        );

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/price',
        });

        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({
            error: {
                code: 'MARKET_DATA_UNAVAILABLE',
                message: 'Market data is temporarily unavailable',
            },
        });

        await app.close();
    });

    it('returns 502 when market data provider fails during analysis', async () => {
        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new MarketDataError('Binance API error: 503'),
        );

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({
            error: {
                code: 'MARKET_DATA_UNAVAILABLE',
                message: 'Market data is temporarily unavailable',
            },
        });

        await app.close();
    });

    it('returns 500 for unexpected errors during analysis', async () => {
        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new Error('Unexpected error'),
        );

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
            },
        });

        await app.close();
    });
    it('returns 500 for unexpected errors', async () => {
        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new Error('Unexpected error'),
        );

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/price',
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
            },
        });

        await app.close();
    });
});
