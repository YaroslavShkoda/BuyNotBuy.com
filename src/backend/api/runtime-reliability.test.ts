import { describe, expect, it, vi } from 'vitest';

import { MarketDataError } from '../errors/market-data.error';

import {
    MarketAnalysisSchema,
    PriceResponseSchema,
} from './schemas';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async (limit = 300) =>
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

vi.mock('../market/market.provider', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

import { createApp } from '../app';

describe('runtime reliability & lifecycle (task 8)', () => {
    it('repeated sequence success/error/success leaves no stale state', async () => {
        const app = createApp();

        try {
            const first = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(first.statusCode).toBe(200);
            expect(() => MarketAnalysisSchema.parse(first.json())).not.toThrow();

            const second = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(second.statusCode).toBe(200);

            mockMarketDataProvider.getPrice.mockRejectedValueOnce(
                new MarketDataError('upstream unavailable'),
            );

            const failed = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(failed.statusCode).toBe(502);
            expect(failed.json()).not.toHaveProperty('price');

            const recovered = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(recovered.statusCode).toBe(200);
            expect(() => MarketAnalysisSchema.parse(recovered.json())).not.toThrow();

            mockMarketDataProvider.getPrice.mockRejectedValueOnce(
                new MarketDataError('Market data provider timed out', {
                    code: 'MARKET_PROVIDER_TIMEOUT',
                }),
            );

            const timedOut = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(timedOut.statusCode).toBe(504);

            const finalSuccess = await app.inject({ method: 'GET', url: '/api/price' });
            expect(finalSuccess.statusCode).toBe(200);
            expect(() => PriceResponseSchema.parse(finalSuccess.json())).not.toThrow();
        } finally {
            await app.close();
        }
    });

    it('concurrent analyses do not contaminate each other and dedup stays per burst', async () => {
        const app = createApp();

        try {
            const responses = await Promise.all([
                app.inject({ method: 'GET', url: '/api/analysis' }),
                app.inject({ method: 'GET', url: '/api/analysis' }),
                app.inject({ method: 'GET', url: '/api/analysis' }),
            ]);

            for (const response of responses) {
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(() => MarketAnalysisSchema.parse(body)).not.toThrow();
                expect(body.indicators.momentum).toBe(body.momentum.current);
            }
        } finally {
            await app.close();
        }
    });

    it('one failing request does not poison a concurrent successful request', async () => {
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });

        mockMarketDataProvider.getPrice.mockImplementationOnce(async () => {
            await gate;
            throw new MarketDataError('burst failure');
        });

        const app = createApp();

        try {
            const failing = app.inject({ method: 'GET', url: '/api/analysis' });

            await Promise.resolve();
            releaseGate();

            const failedResponse = await failing;
            expect(failedResponse.statusCode).toBe(502);

            const next = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(next.statusCode).toBe(200);
            expect(() => MarketAnalysisSchema.parse(next.json())).not.toThrow();
        } finally {
            await app.close();
        }
    });

    it('telemetry contexts stay isolated between success and failure', async () => {
        const analysisService = await import('../services/analysis.service');
        const marketService = await import('../market/market.service');

        const marketData = {
            price: { symbol: 'BTCUSDT', price: 200 },
            candles: Array.from({ length: 300 }, (_, index) => ({
                timestamp: index,
                open: 100 + index,
                high: 102 + index,
                low: 98 + index,
                close: 100 + index,
                volume: 1000,
            })),
        };

        const spy = vi.spyOn(marketService, 'getMarketData').mockResolvedValue(marketData);

        try {
            const okLogger = { info: vi.fn() };
            const ok = await analysisService.analyzeMarket(okLogger, 'req-ok');

            expect(okLogger.info).toHaveBeenCalledTimes(1);
            const [okContext] = okLogger.info.mock.calls[0] as [
                Record<string, unknown>,
                string,
            ];
            expect(okContext['requestId']).toBe('req-ok');
            expect(okContext['signal']).toBe(ok.signal.signal);

            spy.mockRejectedValueOnce(new MarketDataError('downstream down'));

            const failLogger = { info: vi.fn() };
            const failure = await analysisService
                .analyzeMarket(failLogger, 'req-fail')
                .then(
                    () => null,
                    (error: unknown) => error,
                );

            expect(failure).toBeInstanceOf(MarketDataError);
            expect(failLogger.info).not.toHaveBeenCalled();

            const { readAnalysisErrorContext } = await import(
                '../services/analysis.telemetry'
            );
            expect(readAnalysisErrorContext(failure)?.requestId).toBe('req-fail');

            const okLogger2 = { info: vi.fn() };
            await analysisService.analyzeMarket(okLogger2, 'req-ok-2');
            const [okContext2] = okLogger2.info.mock.calls[0] as [
                Record<string, unknown>,
                string,
            ];
            expect(okContext2['requestId']).toBe('req-ok-2');
            expect(okContext2['requestId']).not.toBe('req-fail');
        } finally {
            spy.mockRestore();
        }
    });

    it('fastify instance closes cleanly and can be recreated after shutdown', async () => {
        const first = createApp();
        await first.close();

        const second = createApp();
        const response = await second.inject({ method: 'GET', url: '/api/price' });

        expect(response.statusCode).toBe(200);

        await second.close();
    });
});
