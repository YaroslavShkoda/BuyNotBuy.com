import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { consensusConfig } from '../../config/consensus.config.js';

const mockAnalysis = {
    timestamp: 123456789,
    price: 80000,    indicators: {
        ema300: 78000,
        stochastic: 20,
        momentum: 150,
        atr: 0.015,
        rsi: 52.5,
        macd: { macd: 12.5, signal: 9.75, histogram: 2.75 },
    },
    signal: {
        signal: 'LONG' as const,
        confidence: 50,
        reason: 'Только EMA 300 подтверждает LONG',
        indicators: [
            {
                key: 'ema' as const,
                name: 'EMA 300',
                signal: 'LONG' as const,
                reason: 'Цена выше EMA 300 (3 закрытия подряд)',
                weight: 0.8,
            },
            {
                key: 'stochastic' as const,
                name: 'Стохастик',
                signal: 'NEUTRAL' as const,
                reason: 'Стохастик в нейтральной зоне',
                weight: 0,
            },
        ],
    },
    momentum: {
        period: 100,
        current: 150,
        series: [null, 10, 150] as Array<number | null>,
    },
    divergence: {
        bullish: null,
        bearish: null,
    },
    periods: {
        ema: 300,
        stochastic: 100,
        momentum: 100,
        atr: 14,
        rsi: 14,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
    },
};

/**
 * The explanation, next to the signal it explains.
 *
 * Built from the same numbers rather than written by hand, so the stub cannot
 * drift into describing a different signal than the one it sits beside — which
 * is the one thing an explanation stub always ends up doing.
 */
const mockExplanation = {
    direction: 'LONG' as const,
    supporting: mockAnalysis.signal.indicators.filter(
        (indicator) => indicator.signal === 'LONG',
    ),
    opposing: [],
    abstaining: mockAnalysis.signal.indicators.filter(
        (indicator) => indicator.signal === 'NEUTRAL',
    ),
    regime: null,
    quality: null,
    factors: [],
    confidence: {
        value: mockAnalysis.signal.confidence,
        // Read from the config rather than written out. My first version said
        // `PANEL_SHARE`, a model that does not exist in the schema — a stub that
        // names a model the system cannot produce is a stub describing a
        // different system.
        model: consensusConfig.confidenceModel,
        meaning: 'доля панели, не вероятность',
        isProbabilityOfBeingRight: false as const,
    },
    reason: mockAnalysis.signal.reason,
};

vi.mock('../../services/analysis.service.js', () => ({
    analyzeMarket: vi.fn(async () => mockAnalysis),
    analyzeMarketWithStatus: vi.fn(async () => ({
        analysis: mockAnalysis,
        explanation: mockExplanation,
        stale: false,
        ageMs: 0,
        freshness: 'fresh' as const,
        provider: 'binance',
    })),
}));

import { analysisRoutes } from './analysis.js';
import { analyzeMarketWithStatus } from '../../services/analysis.service.js';

describe('GET /api/analysis', () => {
    it('returns complete market analysis', async () => {
        const app = Fastify();

        await app.register(analysisRoutes);

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(200);

        const body = response.json();

        expect(body).toEqual(mockAnalysis);
        expect(analyzeMarketWithStatus).toHaveBeenCalledTimes(1);

        // A live reading is declared as such, so a consumer never has to
        // guess whether it is looking at a repeated snapshot.
        expect(response.headers['x-data-stale']).toBe('false');
        expect(response.headers['x-data-age-ms']).toBe('0');

        await app.close();
    });

    it('flags a response served from the fallback snapshot', async () => {
        vi.mocked(analyzeMarketWithStatus).mockResolvedValueOnce({
            analysis: mockAnalysis,
            explanation: mockExplanation,
            stale: true,
            ageMs: 245_000,
            freshness: 'stale',
            provider: 'bitget',
        });

        const app = Fastify();

        await app.register(analysisRoutes);

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(mockAnalysis);
        expect(response.headers['x-data-stale']).toBe('true');
        expect(response.headers['x-data-age-ms']).toBe('245000');
        expect(response.headers['cache-control']).toBe('no-store');
        // The two headers that the boolean alone cannot express: which of the
        // six states this is, and which venue answered.
        expect(response.headers['x-data-freshness']).toBe('stale');
        expect(response.headers['x-data-provider']).toBe('bitget');

        await app.close();
    });
});
