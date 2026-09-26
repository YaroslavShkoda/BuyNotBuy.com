import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketDataError } from '../errors/market-data.error.js';
import { freshMarketData } from '../test-support/market-data-result.js';

import {
    MarketAnalysisSchema,
    PriceResponseSchema,
} from './schemas.js';

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
import { marketConfig } from '../config/market.config.js';

describe('runtime reliability & lifecycle (task 8)', () => {
    beforeEach(() => {
        // The snapshot cache is process-wide and would otherwise let a healthy
        // response cover for a provider failure asserted later in a test.
        resetMarketDataCache();
    });

    it('repeated sequence success/error/success leaves no stale state', async () => {
        const app = createApp();

        try {
            const first = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(first.statusCode).toBe(200);
            expect(() => MarketAnalysisSchema.parse(first.json())).not.toThrow();

            const second = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(second.statusCode).toBe(200);

            // The snapshot cache has to be dropped for the provider to be
            // consulted again; with a warm cache the queued rejection below
            // would simply never be reached.
            resetMarketDataCache();

            mockMarketDataProvider.getCandles.mockRejectedValueOnce(
                new MarketDataError('upstream unavailable'),
            );

            const failed = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(failed.statusCode).toBe(502);
            expect(failed.json()).not.toHaveProperty('price');

            const recovered = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(recovered.statusCode).toBe(200);
            expect(() => MarketAnalysisSchema.parse(recovered.json())).not.toThrow();

            resetMarketDataCache();

            mockMarketDataProvider.getCandles.mockRejectedValueOnce(
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
        mockMarketDataProvider.getPrice.mockClear();
        mockMarketDataProvider.getCandles.mockClear();

        try {
            const responses = await Promise.all(
                Array.from({ length: 10 }, () =>
                    app.inject({ method: 'GET', url: '/api/analysis' }),
                ),
            );

            for (const response of responses) {
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(() => MarketAnalysisSchema.parse(body)).not.toThrow();
                expect(body.indicators.momentum).toBe(body.momentum.current);
            }

            expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it('isolates request IDs across concurrent analysis telemetry', async () => {
        const analysisService = await import('../services/analysis.service');
        const requestIds = Array.from({ length: 10 }, (_, index) => `parallel-${index}`);
        const loggers = requestIds.map(() => ({ info: vi.fn() }));

        await Promise.all(requestIds.map((requestId, index) =>
            analysisService.analyzeMarket(loggers[index], requestId),
        ));

        const observedIds = loggers.map((logger) => {
            expect(logger.info).toHaveBeenCalledTimes(1);
            const [context] = logger.info.mock.calls[0] as [
                Record<string, unknown>,
                string,
            ];
            return context['requestId'];
        });

        expect(observedIds).toEqual(requestIds);
        expect(new Set(observedIds).size).toBe(requestIds.length);
    });

    it('recovers after a provider failure in a success/failure/success sequence', async () => {
        const app = createApp();
        let call = 0;
        mockMarketDataProvider.getCandles.mockImplementation(async () => {
            call += 1;

            if (call === 2) {
                throw new MarketDataError('injected provider failure');
            }

            return Array.from({ length: 900 }, (_, index) => ({
                timestamp: index,
                open: 100 + index,
                high: 102 + index,
                low: 98 + index,
                close: 100 + index,
                volume: 1000,
            }));
        });

        try {
            const first = await app.inject({ method: 'GET', url: '/api/analysis' });
            const cached = await app.inject({ method: 'GET', url: '/api/analysis' });

            expect(first.statusCode).toBe(200);
            // The second call is served from the snapshot cache, so the
            // provider is never reached and the injected failure cannot
            // surface. The dashboard degrades instead of blanking.
            expect(cached.statusCode).toBe(200);
            expect(cached.headers['x-data-stale']).toBe('false');

            // With no snapshot to fall back on, the failure is reported.
            resetMarketDataCache();

            const failed = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(failed.statusCode).toBe(502);

            const recovered = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(recovered.statusCode).toBe(200);
            expect(recovered.headers['x-data-stale']).toBe('false');
            expect(() => MarketAnalysisSchema.parse(recovered.json())).not.toThrow();
        } finally {
            mockMarketDataProvider.getCandles.mockReset();
            mockMarketDataProvider.getCandles.mockImplementation(
                async (limit = 900) => Array.from({ length: limit }, (_, index) => ({
                    timestamp: index,
                    open: 100 + index,
                    high: 102 + index,
                    low: 98 + index,
                    close: 100 + index,
                    volume: 1000,
                })),
            );
            await app.close();
        }
    });

    it('serves the last good snapshot with an explicit stale flag when the provider dies', async () => {
        const app = createApp();

        try {
            const fresh = await app.inject({ method: 'GET', url: '/api/analysis' });
            expect(fresh.statusCode).toBe(200);
            expect(fresh.headers['x-data-stale']).toBe('false');

            const body = fresh.json();

            // Let the snapshot age past its TTL, then take the provider down.
            vi.useFakeTimers({ toFake: ['Date'] });

            try {
                vi.advanceTimersByTime(marketConfig.cacheTtlMs + 1);

                mockMarketDataProvider.getCandles.mockRejectedValueOnce(
                    new MarketDataError('upstream unavailable'),
                );

                const degraded = await app.inject({
                    method: 'GET',
                    url: '/api/analysis',
                });

                // A short outage blanks the dashboard only if the last good
                // candles are thrown away; the payload is still correct and
                // the header says outright that it is a repeated snapshot.
                expect(degraded.statusCode).toBe(200);
                expect(degraded.headers['x-data-stale']).toBe('true');
                expect(Number(degraded.headers['x-data-age-ms'])).toBeGreaterThan(0);
                expect(degraded.headers['cache-control']).toBe('no-store');
                expect(() => MarketAnalysisSchema.parse(degraded.json())).not.toThrow();
                expect(degraded.json().momentum.series).toEqual(body.momentum.series);
            } finally {
                vi.useRealTimers();
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

        mockMarketDataProvider.getCandles.mockImplementationOnce(async () => {
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
            candles: Array.from({ length: 900 }, (_, index) => ({
                timestamp: index,
                open: 100 + index,
                high: 102 + index,
                low: 98 + index,
                close: 100 + index,
                volume: 1000,
            })),
        };

        const spy = vi.spyOn(marketService, 'getMarketData').mockResolvedValue(freshMarketData(marketData));

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
