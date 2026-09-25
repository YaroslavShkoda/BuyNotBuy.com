import { describe, expect, it, vi } from 'vitest';

import { marketConfig } from '../config/market.config';

import {
    MarketAnalysisSchema,
    MarketDataSchema,
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

vi.mock('../history/signal-history.service', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

function risingCandles(length: number) {
    return Array.from({ length }, (_, index) => ({
        timestamp: index,
        open: 100 + index,
        high: 102 + index,
        low: 98 + index,
        close: 100 + index,
        volume: 1000,
    }));
}

describe('integration boundaries (task 6)', () => {
    it('market -> indicators wiring: changed candles reach EMA/Stochastic/Momentum results', async () => {
        const { calculateMarketIndicators } = await import(
            '../indicators/indicator.service'
        );

        const base = {
            price: { symbol: 'BTCUSDT', price: 400 },
            candles: risingCandles(300),
        };

        const baseline = calculateMarketIndicators(base);

        expect(baseline).toHaveProperty('ema300');
        expect(baseline).toHaveProperty('stochastic');
        expect(baseline).toHaveProperty('momentum');

        const shifted = calculateMarketIndicators({
            ...base,
            candles: risingCandles(300).map((candle) => ({
                ...candle,
                close: candle.close + 50,
                high: candle.high + 50,
                low: candle.low + 50,
                open: candle.open + 50,
            })),
        });

        expect(shifted.ema300).not.toBe(baseline.ema300);
        expect(typeof shifted.stochastic).toBe('number');
        expect(typeof shifted.momentum).toBe('number');
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

        const indicators = calculateMarketIndicators({
            price: { symbol: 'BTCUSDT', price: 400 },
            candles: risingCandles(300),
        });

        const result = calculateSignal(400, indicators);

        expect(result.indicators.map((entry) => entry.name)).toEqual([
            'EMA 300',
            'Стохастик',
            'Momentum 100',
        ]);

        const expectedConsensus = calculateConsensus(result.indicators);

        expect(result.signal).toBe(expectedConsensus.signal);
        expect(result.confidence).toBe(expectedConsensus.confidence);
        expect(result.reason).toBe(expectedConsensus.reason);
    });

    it('divergence pipeline: analysis keeps the series-built divergence result', async () => {
        const analysisService = await import('../services/analysis.service');
        const divergenceService = await import(
            '../indicators/divergence.service'
        );
        const marketService = await import('../market/market.service');

        const marketData = {
            price: { symbol: 'BTCUSDT', price: 200 },
            candles: risingCandles(300),
        };

        const spy = vi
            .spyOn(marketService, 'getMarketData')
            .mockResolvedValue(marketData);
        const divergenceSpy = vi.spyOn(
            divergenceService,
            'analyzeDivergence',
        );

        try {
            const result = await analysisService.analyzeMarket();

            expect(divergenceSpy).toHaveBeenCalledTimes(1);

            const series = divergenceSpy.mock.calls[0]?.[5];

            expect(Array.isArray(series)).toBe(true);
            expect(series).toHaveLength(marketData.candles.length);
            expect(result.divergence).toEqual(divergenceSpy.mock.results[0]?.value);
            expect(result.momentum.series).toBe(series);
        } finally {
            spy.mockRestore();
            divergenceSpy.mockRestore();
        }
    });

    it('analysis full pipeline: fields stay consistent without inventing new values', async () => {
        const analysisService = await import('../services/analysis.service');
        const marketService = await import('../market/market.service');

        const marketData = {
            price: { symbol: 'BTCUSDT', price: 200 },
            candles: risingCandles(300),
        };

        const spy = vi
            .spyOn(marketService, 'getMarketData')
            .mockResolvedValue(marketData);

        try {
            const result = await analysisService.analyzeMarket();

            expect(result.price).toBe(marketData.price.price);
            expect(result.momentum.period).toBe(100);
            expect(result.momentum.series).toHaveLength(
                marketData.candles.length,
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
                marketConfig.defaultCandleLimit,
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

            expect(body.price).toEqual({
                symbol: 'BTCUSDT',
                price: 80000,
            });
            expect(body.candles).toHaveLength(
                marketConfig.defaultCandleLimit,
            );
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

        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
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

        const marketData = {
            price: { symbol: 'BTCUSDT', price: 200 },
            candles: risingCandles(300),
        };

        const spy = vi
            .spyOn(marketService, 'getMarketData')
            .mockResolvedValue(marketData);

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
