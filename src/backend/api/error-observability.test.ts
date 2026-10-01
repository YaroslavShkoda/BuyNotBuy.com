import { currentCandles } from '../test-support/candles.js';
import { marketData } from '../test-support/market-data.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketDataError } from '../errors/market-data.error.js';
import { marketConfig } from '../config/market.config.js';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    const base = {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async (limit = 900) =>
            currentCandles(limit),
        ),
    };

    return {
        mockAnyProviderAvailable: vi.fn(() => true),
        mockMarketDataProvider: {
            ...base,
            getAttributedCandles: vi.fn(async (limit?: number) => ({
                venue: 'binance',
                symbol: 'BTCUSDT',
                candles: await base.getCandles(limit),
            })),
        },
    };
});

vi.mock('../market/market.provider.js', () => ({
    // The router hands the service a provider for the market it was asked
    // about. Every test here has one market, so it hands back the one stub —
    // the routing itself is exercised in capability.test.ts, where a wrong
    // answer is a property failure rather than a mistyped URL.
    marketProviderFor: () => mockMarketDataProvider,
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    requestedMarketSymbol: vi.fn(() => 'BTCUSDT'),
}));

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from '../app.js';
import { ApiErrorResponseSchema } from './schemas.js';
import { getMarketData, resetMarketDataCache } from '../market/market.service.js';
import { freshMarketData } from '../test-support/market-data-result.js';
import { analyzeMarket } from '../services/analysis.service.js';
import { readAnalysisErrorContext } from '../services/analysis.telemetry.js';

import type { MarketAnalysis } from '../types/analysis.js';

import * as marketService from '../market/market.service.js';
import * as indicatorService from '../indicators/indicator.service.js';
import * as divergenceService from '../indicators/divergence.service.js';
import * as signalService from '../signals/signal.service.js';

function risingCandles(length: number) {
    return currentCandles(length);
}

function createMarketData() {
    return marketData(risingCandles(900), {
        price: { symbol: 'BTCUSDT', price: 200 },
    });
}

function catchAnalysisError(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => null,
        (caught: unknown) => caught,
    );
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('error observability & diagnostics (task 17)', () => {
    beforeEach(() => {
        // The market snapshot cache is process-wide; without a reset a healthy
        // response from an earlier test would satisfy a later error-path test
        // and hide the failure it is meant to assert.
        resetMarketDataCache();
    });

    describe('failed-stage diagnostics', () => {
        it('marks market-data stage on provider failure and skips later stages', async () => {
            const marketDataSpy = vi.spyOn(marketService, 'getMarketData')
                .mockRejectedValueOnce(new MarketDataError('upstream unavailable'));
            const indicatorsSpy = vi.spyOn(indicatorService, 'calculateMarketIndicators');

            const error = await catchAnalysisError(
                analyzeMarket(undefined, 'req-stage-market-data'),
            );

            expect(error).toBeInstanceOf(MarketDataError);

            const context = readAnalysisErrorContext(error);
            expect(context).toBeDefined();
            expect(context?.failedStage).toBe('market-data');
            expect(context?.requestId).toBe('req-stage-market-data');
            expect(context?.totalDurationMs).toBeGreaterThanOrEqual(0);
            expect(context).not.toHaveProperty('indicatorsDurationMs');
            expect(indicatorsSpy).not.toHaveBeenCalled();
            expect(marketDataSpy).toHaveBeenCalledTimes(1);
        });

        it('marks indicators stage and skips downstream stages on indicator failure', async () => {
            vi.spyOn(marketService, 'getMarketData')
                .mockResolvedValueOnce(freshMarketData(createMarketData()));
            vi.spyOn(indicatorService, 'calculateMarketIndicators')
                .mockImplementationOnce(() => {
                    throw new Error('indicator computation failed');
                });
            const divergenceSpy = vi.spyOn(divergenceService, 'analyzeDivergence');
            const signalSpy = vi.spyOn(signalService, 'calculateSignal');

            const error = await catchAnalysisError(
                analyzeMarket(undefined, 'req-stage-indicators'),
            );

            expect(String(error)).toContain('indicator computation failed');

            const context = readAnalysisErrorContext(error);
            expect(context).toBeDefined();
            expect(context?.failedStage).toBe('indicators');
            expect(context?.requestId).toBe('req-stage-indicators');
            expect(context?.marketDataDurationMs).toBeTypeOf('number');
            expect(context).not.toHaveProperty('indicatorsDurationMs');
            expect(divergenceSpy).not.toHaveBeenCalled();
            expect(signalSpy).not.toHaveBeenCalled();
        });

        it('marks divergence stage with completed prior stage durations', async () => {
            vi.spyOn(marketService, 'getMarketData')
                .mockResolvedValueOnce(freshMarketData(createMarketData()));
            vi.spyOn(divergenceService, 'analyzeDivergence')
                .mockImplementationOnce(() => {
                    throw new Error('divergence computation failed');
                });
            const signalSpy = vi.spyOn(signalService, 'calculateSignal');

            const error = await catchAnalysisError(
                analyzeMarket(undefined, 'req-stage-divergence'),
            );

            expect(String(error)).toContain('divergence computation failed');

            const context = readAnalysisErrorContext(error);
            expect(context).toBeDefined();
            expect(context?.failedStage).toBe('divergence');
            expect(context?.requestId).toBe('req-stage-divergence');
            expect(context?.marketDataDurationMs).toBeTypeOf('number');
            expect(context?.indicatorsDurationMs).toBeTypeOf('number');
            expect(context).not.toHaveProperty('divergenceDurationMs');
            expect(context).not.toHaveProperty('signalDurationMs');
            expect(signalSpy).not.toHaveBeenCalled();
        });

        it('marks signal stage after all prior stages completed', async () => {
            vi.spyOn(marketService, 'getMarketData')
                .mockResolvedValueOnce(freshMarketData(createMarketData()));
            vi.spyOn(signalService, 'calculateSignal')
                .mockImplementationOnce(() => {
                    throw new Error('signal computation failed');
                });

            const error = await catchAnalysisError(
                analyzeMarket(undefined, 'req-stage-signal'),
            );

            expect(String(error)).toContain('signal computation failed');

            const context = readAnalysisErrorContext(error);
            expect(context).toBeDefined();
            expect(context?.failedStage).toBe('signal');
            expect(context?.requestId).toBe('req-stage-signal');
            expect(context?.marketDataDurationMs).toBeTypeOf('number');
            expect(context?.indicatorsDurationMs).toBeTypeOf('number');
            expect(context?.divergenceDurationMs).toBeTypeOf('number');
            expect(context).not.toHaveProperty('signalDurationMs');
        });

        it('attaches stage diagnostics without requestId when request id is absent', async () => {
            vi.spyOn(marketService, 'getMarketData')
                .mockRejectedValueOnce(new MarketDataError('upstream unavailable'));

            const error = await catchAnalysisError(analyzeMarket());

            expect(error).toBeInstanceOf(MarketDataError);

            const context = readAnalysisErrorContext(error);
            expect(context).toBeDefined();
            expect(context?.failedStage).toBe('market-data');
            expect(context).not.toHaveProperty('requestId');
        });
    });

    describe('request id & telemetry isolation', () => {
        it('keeps diagnostics isolated across 10 concurrent requests with mixed outcomes', async () => {
            let call = 0;
            const marketDataSpy = vi.spyOn(marketService, 'getMarketData')
                .mockImplementation(async () => {
                    call += 1;
                    if (call === 1) {
                        throw new MarketDataError('first request timed out', {
                            code: 'MARKET_PROVIDER_TIMEOUT',
                        });
                    }
                    return freshMarketData(createMarketData());
                });

            try {
                const requestIds = Array.from(
                    { length: 10 },
                    (_, index) => `mixed-${index}`,
                );
                const loggers = requestIds.map(() => ({ info: vi.fn(), error: vi.fn() }));

                const settled = await Promise.allSettled(
                    requestIds.map((requestId, index) =>
                        analyzeMarket(loggers[index], requestId),
                    ),
                );

                const rejected = settled.filter(
                    (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
                );
                const fulfilled = settled.filter(
                    (entry): entry is PromiseFulfilledResult<MarketAnalysis> => entry.status === 'fulfilled',
                );
                expect(rejected).toHaveLength(1);
                expect(fulfilled).toHaveLength(9);

                const failureReason = rejected[0]?.reason;
                expect(failureReason).toBeInstanceOf(MarketDataError);

                if (failureReason instanceof MarketDataError) {
                    expect(failureReason.code).toBe('MARKET_PROVIDER_TIMEOUT');
                    expect(failureReason.statusCode).toBe(504);
                }

                const failureContext = readAnalysisErrorContext(failureReason);
                expect(failureContext?.failedStage).toBe('market-data');
                expect(failureContext?.requestId).toBe('mixed-0');

                const [failingLogger] = loggers;
                expect(failingLogger?.info).not.toHaveBeenCalled();

                const successRequestIds = loggers.slice(1).map((logger) => {
                    expect(logger.info).toHaveBeenCalledTimes(1);
                    const [context] = logger.info.mock.calls[0] as [
                        Record<string, unknown>,
                        string,
                    ];
                    expect(context['event']).toBe('market_analysis_completed');
                    expect(context).not.toHaveProperty('failedStage');
                    return context['requestId'];
                });

                expect(successRequestIds).toEqual(requestIds.slice(1));

                const observedIds = new Set([
                    failureContext?.requestId,
                    ...successRequestIds,
                ]);
                expect(observedIds.size).toBe(requestIds.length);
            } finally {
                marketDataSpy.mockRestore();
            }
        });

        it('does not leak failedStage into telemetry of a subsequent success', async () => {
            let call = 0;
            const marketDataSpy = vi.spyOn(marketService, 'getMarketData')
                .mockImplementation(async () => {
                    call += 1;
                    if (call === 2) {
                        throw new MarketDataError('transient outage');
                    }
                    return freshMarketData(createMarketData());
                });

            try {
                const firstLogger = { info: vi.fn(), error: vi.fn() };
                await analyzeMarket(firstLogger, 'recovery-first');

                const failure = await catchAnalysisError(
                    analyzeMarket({ info: vi.fn(), error: vi.fn() }, 'recovery-failure'),
                );
                const failureContext = readAnalysisErrorContext(failure);
                expect(failureContext?.failedStage).toBe('market-data');
                expect(failureContext?.requestId).toBe('recovery-failure');

                const recoveredLogger = { info: vi.fn(), error: vi.fn() };
                await analyzeMarket(recoveredLogger, 'recovery-after');

                expect(firstLogger.info).toHaveBeenCalledTimes(1);
                expect(recoveredLogger.info).toHaveBeenCalledTimes(1);

                const [recoveredContext] = recoveredLogger.info.mock.calls[0] as [
                    Record<string, unknown>,
                    string,
                ];
                expect(recoveredContext['event']).toBe('market_analysis_completed');
                expect(recoveredContext['requestId']).toBe('recovery-after');
                expect(recoveredContext).not.toHaveProperty('failedStage');
                expect(recoveredContext['requestId']).not.toBe(failureContext?.requestId);
            } finally {
                marketDataSpy.mockRestore();
            }
        });
    });

    describe('error cause diagnostics', () => {
        it('keeps provider context in cause when provider returns no candles', async () => {
            mockMarketDataProvider.getCandles.mockResolvedValueOnce([]);

            const error = await catchAnalysisError(getMarketData());

            if (!(error instanceof MarketDataError)) {
                throw new Error('expected MarketDataError');
            }

            expect(error.code).toBe('MARKET_PROVIDER_ERROR');
            expect(error.statusCode).toBe(502);
            expect(error.cause).toMatchObject({
                provider: marketConfig.provider,
                endpoint: '/api/v3/klines',
                candleCount: 0,
            });
        });
    });

    describe('api boundary sanitization', () => {
        it('keeps unexpected internal errors and their causes out of the public response', async () => {
            mockMarketDataProvider.getPrice.mockRejectedValueOnce(
                new Error('outer failure', { cause: new Error('INTERNAL_SECRET_TOKEN') }),
            );

            const app = createApp();

            try {
                const response = await app.inject({ method: 'GET', url: '/api/price' });

                expect(response.statusCode).toBe(500);

                const body = response.json();
                expect(body).toEqual({
                    error: {
                        code: 'INTERNAL_ERROR',
                        message: 'Internal server error',
                    },
                });

                const serialized = JSON.stringify(body);
                expect(serialized).not.toContain('INTERNAL_SECRET_TOKEN');
                expect(serialized).not.toContain('outer failure');
                expect(serialized).not.toContain('stack');
                expect(serialized).not.toContain('cause');
            } finally {
                await app.close();
            }
        });

        it('maps an unexpected indicator-stage failure to a stable 500 without details', async () => {
            const indicatorSpy = vi.spyOn(indicatorService, 'calculateMarketIndicators')
                .mockImplementationOnce(() => {
                    throw new Error('indicator computation failed with secret-details');
                });

            const app = createApp();

            try {
                const response = await app.inject({ method: 'GET', url: '/api/analysis' });

                expect(response.statusCode).toBe(500);

                const body = response.json();
                expect(body).toEqual({
                    error: {
                        code: 'INTERNAL_ERROR',
                        message: 'Internal server error',
                    },
                });

                const serialized = JSON.stringify(body);
                expect(serialized).not.toContain('secret-details');
                expect(serialized).not.toContain('indicator computation');
            } finally {
                indicatorSpy.mockRestore();
                await app.close();
            }
        });

        it('surfaces rate-limit style provider errors as 503 with stable code', async () => {
            mockMarketDataProvider.getPrice.mockRejectedValueOnce(
                new MarketDataError('provider rate limited', {
                    code: 'MARKET_DATA_UNAVAILABLE',
                    statusCode: 503,
                }),
            );

            const app = createApp();

            try {
                const response = await app.inject({ method: 'GET', url: '/api/price' });

                expect(response.statusCode).toBe(503);

                const body = response.json();
                expect(() => ApiErrorResponseSchema.parse(body)).not.toThrow();
                expect(body).toEqual({
                    error: {
                        code: 'MARKET_DATA_UNAVAILABLE',
                        message: 'Market data is temporarily unavailable',
                    },
                });
            } finally {
                await app.close();
            }
        });

        it('surfaces provider rejection errors as 502 with stable code on /api/market', async () => {
            mockMarketDataProvider.getCandles.mockRejectedValueOnce(
                new MarketDataError('provider rejected the request', {
                    code: 'MARKET_PROVIDER_ERROR',
                }),
            );

            const app = createApp();

            try {
                const response = await app.inject({ method: 'GET', url: '/api/market' });

                expect(response.statusCode).toBe(502);
                expect(response.json()).toEqual({
                    error: {
                        code: 'MARKET_PROVIDER_ERROR',
                        message: 'Market data provider unavailable',
                    },
                });
            } finally {
                await app.close();
            }
        });

        it('maps a malformed internal market response to a stable 502 on /api/market', async () => {
            mockMarketDataProvider.getCandles.mockResolvedValueOnce([
                { timestamp: 'not-a-number' },
            ] as unknown as Awaited<ReturnType<typeof mockMarketDataProvider.getCandles>>);

            const app = createApp();

            try {
                const response = await app.inject({ method: 'GET', url: '/api/market' });

                // Broken candles come from the provider, so the blame — and the
                // status — belongs to the upstream, not to this service.
                expect(response.statusCode).toBe(502);
                expect(response.json()).toEqual({
                    error: {
                        code: 'MARKET_PROVIDER_ERROR',
                        message: 'Market data provider unavailable',
                    },
                });
            } finally {
                await app.close();
            }
        });
    });

    // Thirty seconds, the budget the rest of this repository states for tests
    // that do real work — and I said for two rounds that this file did not
    // deserve one, on the grounds that 184 ms is not real work. That was a
    // single observation generalised into a rule, which is the thing this project
    // keeps refusing to do to itself, so the rule got measured instead.
    //
    // Timed across four full runs on this machine, the boundary test below took
    // 184 ms isolated, 875 ms inside a 212-file run, and 5465 ms inside another —
    // and that last one failed against the 5 s default. The work is not thirty
    // times slower under load; the contention factor is, and it belongs to the
    // machine rather than to the assertion.
    //
    // What tipped it over my own objection is which test this is. This describe
    // asserts that an unexpected internal error and its causes stay out of the
    // public response — the boundary where a stack trace becomes a disclosure.
    // A guard that fails for being slow is a guard that gets re-run, and a
    // re-run that comes back green is read as "the response does not leak". A
    // cosmetic test that flakes costs a rerun; this one costs the habit that
    // makes reruns meaningless.
    //
    // The budget is therefore here to be exceeded, not to be hit. The number is
    // far above the observed 5.4 s for the same reason the tree-scanning guards
    // got one: the measurement is of the machine, and the assertion is what the
    // file is for.
}, 30_000);
