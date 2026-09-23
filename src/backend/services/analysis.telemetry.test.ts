import { describe, expect, it, vi } from 'vitest';

import {
    attachAnalysisErrorContext,
    buildAnalysisTelemetry,
    measureAsync,
    measureSync,
    readAnalysisErrorContext,
} from './analysis.telemetry';

describe('analysis.telemetry', () => {
    it('measures sync/async durations without asserting thresholds', () => {
        const sync = measureSync(() => 42);
        expect(sync.result).toBe(42);
        expect(sync.durationMs).toBeTypeOf('number');
        expect(sync.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('measures async operations', async () => {
        const asyncResult = await measureAsync(async () => 'ok');
        expect(asyncResult.result).toBe('ok');
        expect(asyncResult.durationMs).toBeTypeOf('number');
        expect(asyncResult.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('builds completed telemetry without candles or series', () => {
        const telemetry = buildAnalysisTelemetry(
            {
                timestamp: 1,
                price: 100,
                indicators: {
                    ema300: 90,
                    stochastic: 20,
                    momentum: 5,
                },
                signal: {
                    signal: 'LONG',
                    confidence: 67,
                    reason: 'reason',
                    indicators: [],
                },
                momentum: {
                    period: 100,
                    current: 5,
                    series: [],
                },
                divergence: {
                    bullish: null,
                    bearish: null,
                },
            },
            {
                marketDataDurationMs: 1,
                indicatorsDurationMs: 2,
                divergenceDurationMs: 3,
                signalDurationMs: 4,
                totalDurationMs: 10,
            },
            {
                provider: 'mock',
                symbol: 'BTCUSDT',
                candleCount: 300,
                candleInterval: '1h',
                requestId: 'req-1',
            },
        );

        expect(telemetry).toEqual({
            event: 'market_analysis_completed',
            provider: 'mock',
            symbol: 'BTCUSDT',
            candleCount: 300,
            candleInterval: '1h',
            marketDataDurationMs: 1,
            indicatorsDurationMs: 2,
            divergenceDurationMs: 3,
            signalDurationMs: 4,
            totalDurationMs: 10,
            signal: 'LONG',
            confidence: 67,
            requestId: 'req-1',
        });
        expect(JSON.stringify(telemetry)).not.toContain('series');
    });

    it('attaches error diagnostics without changing the thrown error', () => {
        const error = new Error('boom');
        attachAnalysisErrorContext(error, {
            totalDurationMs: 5,
            failedStage: 'market-data',
            requestId: 'req-9',
        });

        expect(readAnalysisErrorContext(error)).toEqual({
            totalDurationMs: 5,
            failedStage: 'market-data',
            requestId: 'req-9',
        });
        expect(error.message).toBe('boom');
    });
});

describe('analyzeMarket observability', () => {
    it('emits one diagnostic record without changing the result', async () => {
        const { analyzeMarket } = await import('./analysis.service');
        const marketService = await import('../market/market.service');

        const marketData = {
            price: {
                symbol: 'BTCUSDT',
                price: 200,
            },
            candles: Array.from(
                { length: 300 },
                (_, index) => ({
                    timestamp: index,
                    open: 100,
                    high: 100 + index,
                    low: 100,
                    close: 100 + index,
                    volume: 1000,
                }),
            ),
        };

        const getMarketDataSpy = vi.spyOn(marketService, 'getMarketData')
            .mockResolvedValue(marketData);

        try {
            const baseline = await analyzeMarket();
            const logger = { info: vi.fn() };

            const result = await analyzeMarket(logger, 'req-observability');

            expect({ ...result, timestamp: 0 }).toEqual({ ...baseline, timestamp: 0 });
        expect(logger.info).toHaveBeenCalledTimes(1);

        const [context, message] = logger.info.mock.calls[0] as [
            Record<string, unknown>,
            string,
        ];
        expect(message).toBe('market_analysis_completed');
        expect(context['event']).toBe('market_analysis_completed');
        expect(context['provider']).toBeTypeOf('string');
        expect(context['symbol']).toBe(marketData.price.symbol);
        expect(context['candleCount']).toBe(marketData.candles.length);
        expect(context['signal']).toBe(result.signal.signal);
        expect(context['confidence']).toBe(result.signal.confidence);
        expect(context['requestId']).toBe('req-observability');

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
            getMarketDataSpy.mockRestore();
        }
    });
});
