import { describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getBitcoinPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),

        getBitcoinCandles: vi.fn(async (limit = 500) =>
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

    it('returns market snapshot from /api/market', async () => {
        const app = createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/api/market',
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();

        expect(body.market.price).toEqual({
            symbol: 'BTCUSDT',
            price: 80000,
        });

        expect(body.market.candles).toHaveLength(500);
        expect(body.indicators).toHaveProperty('ema300');
        expect(body.indicators).toHaveProperty('stochastic');

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
});
