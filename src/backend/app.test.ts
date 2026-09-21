import { describe, expect, it, vi } from 'vitest';

import { MarketDataError } from './errors/market-data.error';
import { marketConfig } from './config/market.config';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),

        getCandles: vi.fn(
            async (limit = marketConfig.defaultCandleLimit) =>
                Array.from(
                    { length: limit },
                    (_, index) => ({
                        timestamp: index,
                        open: 100,
                        high: 101,
                        low: 99,
                        close: 100,
                        volume: 1000,
                    }),
                ),
        ),
    },
}));

vi.mock('./market/market.provider', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

import { createApp } from './app';

describe('Backend app', () => {
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
            price: 80000,
        });

        expect(body.candles).toHaveLength(
            marketConfig.defaultCandleLimit,
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

        expect(body.price).toBe(80000);
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
            error: 'Market data provider unavailable',
        });

        await app.close();
    });

    it('returns 502 when market data provider fails during analysis', async () => {
        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new MarketDataError('Binance API error: 503'),
        );

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({
            error: 'Market data provider unavailable',
        });

        await app.close();
    });

    it('returns 500 for unexpected errors during analysis', async () => {
        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new Error('Unexpected error'),
        );

        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
            error: 'Internal server error',
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
            error: 'Internal server error',
        });

        await app.close();
    });
});
