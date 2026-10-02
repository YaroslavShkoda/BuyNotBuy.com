import { currentCandles } from '../test-support/candles.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMarketDataCache } from '../market/market.service.js';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    const base = {
        getPrice: vi.fn(async () => ({ symbol: 'BTCUSDT', price: 80000 })),
        // The provider is always asked for one bar more than the warm-up needs
        // and the still-forming bar is dropped before anything else sees the
        // response, so this stub emulates that too.
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
    marketProviderFor: () => mockMarketDataProvider,
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
}));

const resolveSignal = vi.fn();

vi.mock('../strategies/registry.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../strategies/registry.js')>();

    return { ...actual, resolveSignal };
});

const { analyzeMarket } = await import('./analysis.service.js');

import type { AnalysisTelemetryLogger } from './analysis.telemetry.js';

function loggerThatRecords(): AnalysisTelemetryLogger & {
    errors: Array<{ context: unknown; message: string }>;
} {
    const errors: Array<{ context: unknown; message: string }> = [];

    return {
        errors,
        info: vi.fn(),
        error: (context, message) => {
            errors.push({ context, message });
        },
    };
}

describe('a fallback that fails in a mode where its failure is not fatal', () => {
    beforeEach(() => {
        resolveSignal.mockReset();
        resetMarketDataCache();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('still serves the analysis, and says so', async () => {
        // The decision this file is not arguing with: a broken optional
        // strategy must not take a working answer down with it. Turning the
        // enhancement into a dependency is the worse failure of the two.
        vi.stubEnv('FALLBACK_STRATEGY', 'donchian-trend-gated');
        vi.stubEnv('FALLBACK_MODE', 'shadow');
        resolveSignal.mockImplementation(() => {
            throw new Error('strategy exploded');
        });

        const logger = loggerThatRecords();
        const result = await analyzeMarket(logger, 'req-shadow-failure');

        expect(result.signal.signal).toBeDefined();
    });

    it('records the failure, because a clean log otherwise looks like health', async () => {
        // Before, this catch discarded the error and returned. Every run then
        // looked exactly like every healthy run: the answer was right, the log
        // was clean, and nothing said the enhancement the deployment was
        // configured to evaluate had not been evaluating anything. Silent
        // degradation is the one state a monitoring system is worst at.
        vi.stubEnv('FALLBACK_STRATEGY', 'donchian-trend-gated');
        vi.stubEnv('FALLBACK_MODE', 'shadow');
        resolveSignal.mockImplementation(() => {
            throw new Error('strategy exploded');
        });

        const logger = loggerThatRecords();
        await analyzeMarket(logger, 'req-shadow-failure');

        expect(logger.errors).toHaveLength(1);
        expect(logger.errors[0]?.message).toBe('fallback_strategy_failed');

        const context = logger.errors[0]?.context as Record<string, unknown>;

        expect(context['event']).toBe('fallback_strategy_failed');
        expect(context['mode']).toBe('shadow');
        expect(context['strategy']).toBe('donchian-trend-gated');
        expect(context['primaryAnswerKept']).toBe(true);
        expect((context['err'] as Error).message).toBe('strategy exploded');
    });

    it('names the strategy that broke, not merely that something did', async () => {
        // Without the key, the line says the optional path failed and leaves
        // the reader to guess which one. There are several, and only one of
        // them is configured to be consulted.
        vi.stubEnv('FALLBACK_STRATEGY', 'donchian-20');
        vi.stubEnv('FALLBACK_MODE', 'shadow');
        resolveSignal.mockImplementation(() => {
            throw new Error('strategy exploded');
        });

        const logger = loggerThatRecords();
        await analyzeMarket(logger, 'req-shadow-failure');

        expect(
            (logger.errors[0]?.context as Record<string, unknown>)['strategy'],
        ).toBe('donchian-20');
    });

    it('stays silent when the fallback did not fail', async () => {
        // The control. An error line that fires on every run would be worse
        // than none: it would train whoever reads the logs to ignore the event
        // that was introduced to be read.
        vi.stubEnv('FALLBACK_STRATEGY', 'donchian-trend-gated');
        vi.stubEnv('FALLBACK_MODE', 'shadow');
        resolveSignal.mockImplementation(() => ({
            published: {
                direction: 'LONG',
                confidence: 70,
                reason: 'ok',
            },
            suppressed: true,
        }));

        const logger = loggerThatRecords();
        await analyzeMarket(logger, 'req-shadow-clean');

        expect(logger.errors).toEqual([]);
    });

    it('still fails the run outright when the fallback is authoritative', async () => {
        // In active mode the fallback's answer is the answer, so a fallback
        // that throws is the analysis failing. Recording it as anything else
        // would understate a real outage.
        vi.stubEnv('FALLBACK_STRATEGY', 'donchian-trend-gated');
        vi.stubEnv('FALLBACK_MODE', 'active');
        resolveSignal.mockImplementation(() => {
            throw new Error('strategy exploded');
        });

        const logger = loggerThatRecords();

        await expect(analyzeMarket(logger, 'req-active-failure')).rejects.toThrow(
            /strategy exploded/,
        );
    });
});
