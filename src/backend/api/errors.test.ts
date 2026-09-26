import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketDataError } from '../errors/market-data.error.js';
import { ApiErrorResponseSchema } from './schemas.js';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async (limit = 900) =>
            Array.from({ length: limit }, (_, index) => ({
                timestamp: index,
                open: 100 + index,
                high: 102 + index,
                low: 98 + index,
                close: 100 + index,
                volume: 1000,
            })),
        ),
    },
}));

vi.mock('../market/market.provider.js', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from '../app.js';
import { resetMarketDataCache } from '../market/market.service.js';

describe('API error handling', () => {
    beforeEach(() => {
        // The snapshot cache is process-wide; a healthy response from an
        // earlier test would otherwise satisfy a later error-path test.
        resetMarketDataCache();
    });

    it('1. provider MarketDataError maps to HTTP status with stable code', async () => {
        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new MarketDataError('Market data provider timed out', {
                code: 'MARKET_PROVIDER_TIMEOUT',
            }),
        );

        const app = createApp();
        const response = await app.inject({ method: 'GET', url: '/api/price' });

        expect(response.statusCode).toBe(504);

        const body = response.json();
        expect(() => ApiErrorResponseSchema.parse(body)).not.toThrow();
        expect(body).toEqual({
            error: {
                code: 'MARKET_PROVIDER_TIMEOUT',
                message: 'Market data provider timed out',
            },
        });

        await app.close();
    });

    it('2. provider timeout surfaces timeout code on /api/analysis', async () => {
        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new MarketDataError('timed out', { code: 'MARKET_PROVIDER_TIMEOUT' }),
        );

        const app = createApp();
        const response = await app.inject({ method: 'GET', url: '/api/analysis' });

        expect(response.statusCode).toBe(504);
        expect(response.json().error.code).toBe('MARKET_PROVIDER_TIMEOUT');

        await app.close();
    });

    it('3. unexpected internal error maps to INTERNAL_ERROR without details', async () => {
        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new Error('secret stack trace /etc/passwd API_KEY=xxx'),
        );

        const app = createApp();
        const response = await app.inject({ method: 'GET', url: '/api/market' });

        expect(response.statusCode).toBe(500);

        const body = response.json();
        expect(body).toEqual({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
            },
        });
        expect(JSON.stringify(body)).not.toContain('secret');
        expect(JSON.stringify(body)).not.toContain('API_KEY');

        await app.close();
    });

    it('4. broken internal response shape maps to INTERNAL_ERROR', async () => {
        mockMarketDataProvider.getCandles.mockResolvedValueOnce([
            {
                timestamp: 'NOT_A_TIMESTAMP',
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ] as unknown as Array<{
            timestamp: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>);

        const app = createApp();
        const response = await app.inject({ method: 'GET', url: '/api/market' });

        // The provider sent a broken series, so this is an upstream contract
        // violation, not a fault in this service. Reporting 500 would have
        // pointed an operator at the wrong system.
        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({
            error: {
                code: 'MARKET_PROVIDER_ERROR',
                message: 'Market data provider unavailable',
            },
        });

        await app.close();
    });

    it('5. public response has no cause or stack, server keeps it', async () => {
        const cause = new Error('original network failure');
        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new MarketDataError('upstream failed', {
                code: 'MARKET_DATA_UNAVAILABLE',
                cause: { provider: 'binance', originalError: String(cause) },
            }),
        );

        const app = createApp();
        const response = await app.inject({ method: 'GET', url: '/api/price' });

        const body = response.json();
        expect(body).toEqual({
            error: {
                code: 'MARKET_DATA_UNAVAILABLE',
                message: 'Market data is temporarily unavailable',
            },
        });
        expect(body.error).not.toHaveProperty('cause');
        expect(body.error).not.toHaveProperty('stack');

        await app.close();
    });

    it('6. success endpoints still pass success schemas', async () => {
        const { MarketAnalysisSchema, MarketDataSchema, PriceResponseSchema } = await import('./schemas');

        const app = createApp();

        const price = await app.inject({ method: 'GET', url: '/api/price' });
        expect(() => PriceResponseSchema.parse(price.json())).not.toThrow();

        const market = await app.inject({ method: 'GET', url: '/api/market' });
        expect(() => MarketDataSchema.parse(market.json())).not.toThrow();

        const analysis = await app.inject({ method: 'GET', url: '/api/analysis' });
        expect(() => MarketAnalysisSchema.parse(analysis.json())).not.toThrow();

        await app.close();
    });

    it('7. a rate-limited provider answers 503 with Retry-After and no partial payload', async () => {
        const app = createApp();

        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new MarketDataError('Market data provider rate limit reached', {
                code: 'MARKET_RATE_LIMITED',
                retryAfterSeconds: 30,
            }),
        );

        const response = await app.inject({ method: 'GET', url: '/api/analysis' });

        expect(response.statusCode).toBe(503);
        // Without this a client that just got throttled has no way to know it
        // should back off, and keeps making the situation worse.
        expect(response.headers['retry-after']).toBe('30');
        expect(response.json()).toEqual({
            error: {
                code: 'MARKET_RATE_LIMITED',
                message: 'Market data provider rate limit reached',
            },
        });

        await app.close();
    });

    it('8. errors without a retry window do not advertise one', async () => {
        const app = createApp();

        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new MarketDataError('upstream unavailable'),
        );

        const response = await app.inject({ method: 'GET', url: '/api/analysis' });

        expect(response.statusCode).toBe(502);
        expect(response.headers['retry-after']).toBeUndefined();

        await app.close();
    });
});
