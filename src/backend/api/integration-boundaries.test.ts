import { currentCandles } from '../test-support/candles.js';
import { marketData } from '../test-support/market-data.js';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requiredCandleCount } from '../config/indicator.config.js';
import { resetMarketDataCache } from '../market/market.service.js';
import { freshMarketData } from '../test-support/market-data-result.js';

import {
    MarketAnalysisSchema,
    MarketDataSchema,
    PriceResponseSchema,
} from './schemas.js';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    const base = {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        // The provider is always asked for one bar more than the warm-up
        // needs and the still-forming bar is dropped before anything else
        // sees the response, so this stub emulates that too.
        getCandles: vi.fn(async (limit = 300) =>
            currentCandles(Math.max(0, limit - 1)),
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
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    requestedMarketSymbol: vi.fn(() => 'BTCUSDT'),
}));

function risingCandles(length: number) {
    return currentCandles(length);
}

describe('integration boundaries (task 6)', () => {
    beforeEach(() => {
        // The market snapshot cache is process-wide; without a reset a healthy
        // response would satisfy a later test and hide the failure it asserts.
        resetMarketDataCache();
    });

    it('market -> indicators wiring: changed candles reach EMA/Stochastic/Momentum results', async () => {
        const { calculateMarketIndicators } = await import(
            '../indicators/indicator.service'
        );

        const base = marketData(risingCandles(requiredCandleCount()), {
            price: { symbol: 'BTCUSDT', price: 400 },
        });

        const baseline = calculateMarketIndicators(base);

        expect(baseline).toHaveProperty('ema300');
        expect(baseline).toHaveProperty('stochastic');
        expect(baseline).toHaveProperty('momentum');

        const shifted = calculateMarketIndicators({
            ...base,
            candles: risingCandles(requiredCandleCount()).map((candle) => ({
                ...candle,
                close: candle.close + 10,
            })),
        });

        expect(shifted.ema300).not.toBe(baseline.ema300);
    });

    it('indicators -> signal wiring: signal list and consensus follow the actual indicator values', async () => {
        const { calculateMarketIndicators } = await import(
            '../indicators/indicator.service'
        );
        const { calculateSignal } = await import(
            '../signals/signal.service'
        );
        const { calculateConsensus } = await import(
            '../signals/consensus'
        );

        const indicators = calculateMarketIndicators(
            marketData(risingCandles(requiredCandleCount()), {
                price: { symbol: 'BTCUSDT', price: 400 },
            }),
        );

        const result = calculateSignal(400, indicators);

        expect(result.indicators.map((entry) => entry.name)).toEqual([
            'EMA 300',
            'Стохастик',
            'Momentum 100',
        ]);

        const expectedConsensus = calculateConsensus(result.indicators);

        expect(result.signal).toBe(expectedConsensus.signal);
        expect(result.confidence).toBe(expectedConsensus.confidence);
    });

    it('divergence pipeline: analysis reuses one momentum series for both consumers', async () => {
        const analysisService = await import('../services/analysis.service');
        const marketService = await import('../market/market.service');
        const divergenceService = await import('../indicators/divergence.service');

        const snapshot = marketData(risingCandles(requiredCandleCount()), {
            price: { symbol: 'BTCUSDT', price: 200 },
        });

        const spy = vi
            .spyOn(marketService, 'getMarketData')
            .mockResolvedValue(freshMarketData(snapshot));
        const divergenceSpy = vi.spyOn(
            divergenceService,
            'analyzeDivergence',
        );

        try {
            const result = await analysisService.analyzeMarket();

            expect(divergenceSpy).toHaveBeenCalledTimes(1);

            // One series is computed per request and handed to both the
            // divergence detector and the API payload, so the two can never
            // disagree about what momentum was.
            const options = divergenceSpy.mock.calls[0]?.[1];

            expect(options?.momentumSeries).toBe(result.momentum.series);
            expect(result.momentum.series).toHaveLength(
                snapshot.candles.length,
            );
            expect(result.divergence).toEqual(
                divergenceSpy.mock.results[0]?.value,
            );
        } finally {
            spy.mockRestore();
            divergenceSpy.mockRestore();
        }
    });

    it('analysis full pipeline: fields stay consistent without inventing new values', async () => {
        const analysisService = await import('../services/analysis.service');
        const marketService = await import('../market/market.service');

        const snapshot = marketData(risingCandles(requiredCandleCount()), {
            price: { symbol: 'BTCUSDT', price: 200 },
        });

        const spy = vi
            .spyOn(marketService, 'getMarketData')
            .mockResolvedValue(freshMarketData(snapshot));

        try {
            const result = await analysisService.analyzeMarket();

            expect(result.price).toBe(snapshot.price.price);
            expect(result.momentum.period).toBe(100);
            expect(result.momentum.series).toHaveLength(
                snapshot.candles.length,
            );
            expect(result.indicators.momentum).toBe(result.momentum.current);
            expect(result.momentum.current).toBe(
                result.momentum.series.at(-1),
            );
            expect(() => MarketAnalysisSchema.parse(result)).not.toThrow();
        } finally {
            spy.mockRestore();
        }
    });

    it('GET /api/analysis exposes the full pipeline shape on real services', async () => {
        const { createApp } = await import('../app');

        const app = createApp();

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/analysis',
            });

            expect(response.statusCode).toBe(200);

            const body = response.json();

            expect(body.indicators).toHaveProperty('ema300');
            expect(body.indicators).toHaveProperty('stochastic');
            expect(body.indicators).toHaveProperty('momentum');
            expect(body.momentum.period).toBe(100);
            expect(body.momentum.series).toHaveLength(
                requiredCandleCount(),
            );
            expect(body.indicators.momentum).toBe(body.momentum.current);
            expect(body).toHaveProperty('divergence');
            expect(body).toHaveProperty('signal');
            expect(body.signal).toHaveProperty('indicators');
            expect(body.signal).toHaveProperty('confidence');
            expect(() => MarketAnalysisSchema.parse(body)).not.toThrow();
        } finally {
            await app.close();
        }
    });

    it('GET /api/market matches provider candles and marketConfig limit', async () => {
        const { createApp } = await import('../app');

        const app = createApp();

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/market',
            });

            expect(response.statusCode).toBe(200);

            const body = response.json();

            // The provider is asked for one bar more than the warm-up needs
            // and drops the still-forming one, so exactly the warm-up comes
            // back; the price is the close of that last closed bar.
            expect(body.candles).toHaveLength(requiredCandleCount());
            expect(body.price).toEqual({
                symbol: 'BTCUSDT',
                price: 100 + requiredCandleCount() - 1,
            });
            expect(() => MarketDataSchema.parse(body)).not.toThrow();
        } finally {
            await app.close();
        }
    });

    it('GET /api/price keeps the performance contract: price once, candles never', async () => {
        const { createApp } = await import('../app');

        mockMarketDataProvider.getPrice.mockClear();
        mockMarketDataProvider.getCandles.mockClear();

        const app = createApp();

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.statusCode).toBe(200);
            expect(() => PriceResponseSchema.parse(response.json())).not.toThrow();
            expect(mockMarketDataProvider.getPrice).toHaveBeenCalledTimes(1);
            expect(mockMarketDataProvider.getCandles).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('provider errors never leak as partial success and stay inside the public schema', async () => {
        const { MarketDataError } = await import(
            '../errors/market-data.error'
        );
        const { createApp } = await import('../app');
        const { ApiErrorResponseSchema } = await import('./schemas');

        // Analysis derives the price from the candles, so the failure has to
        // be injected where that derivation reads from.
        mockMarketDataProvider.getCandles.mockRejectedValueOnce(
            new MarketDataError('upstream unavailable'),
        );

        const app = createApp();

        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/analysis',
            });

            expect(response.statusCode).toBe(502);

            const body = response.json();

            expect(() => ApiErrorResponseSchema.parse(body)).not.toThrow();
            expect(body).toEqual({
                error: {
                    code: 'MARKET_DATA_UNAVAILABLE',
                    message: 'Market data is temporarily unavailable',
                },
            });
            expect(body).not.toHaveProperty('price');
            expect(body).not.toHaveProperty('indicators');
            expect(JSON.stringify(body)).not.toContain('stack');
            expect(JSON.stringify(body)).not.toContain('cause');
        } finally {
            await app.close();
        }
    });

    it('telemetry success keeps the result and exposes request/duration fields without thresholds', async () => {
        const analysisService = await import('../services/analysis.service');
        const marketService = await import('../market/market.service');

        const snapshot = marketData(risingCandles(requiredCandleCount()), {
            price: { symbol: 'BTCUSDT', price: 200 },
        });

        const spy = vi
            .spyOn(marketService, 'getMarketData')
            .mockResolvedValue(freshMarketData(snapshot));

        try {
            const baseline = await analysisService.analyzeMarket();
            const logger = { info: vi.fn() };
            const result = await analysisService.analyzeMarket(
                logger,
                'req-integration-6',
            );

            expect({ ...result, timestamp: 0 }).toEqual({
                ...baseline,
                timestamp: 0,
            });
            expect(logger.info).toHaveBeenCalledTimes(1);

            const [context, message] = logger.info.mock.calls[0] as [
                Record<string, unknown>,
                string,
            ];

            expect(message).toBe('market_analysis_completed');
            expect(context['requestId']).toBe('req-integration-6');

            for (const key of [
                'marketDataDurationMs',
                'indicatorsDurationMs',
                'divergenceDurationMs',
                'signalDurationMs',
                'totalDurationMs',
            ]) {
                expect(context[key]).toBeTypeOf('number');
                expect(context[key] as number).toBeGreaterThanOrEqual(0);
            }
        } finally {
            spy.mockRestore();
        }
    });
});
