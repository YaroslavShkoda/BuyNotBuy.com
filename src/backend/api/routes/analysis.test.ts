import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const mockAnalysis = {
    timestamp: 123456789,
    price: 80000,
    indicators: {
        ema300: 78000,
        stochastic: 20,
        momentum: 150,
    },
    signal: {
        signal: 'LONG' as const,
        confidence: 50,
        reason: 'Только EMA 300 подтверждает LONG',
        indicators: [
            {
                name: 'EMA 300',
                signal: 'LONG' as const,
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'NEUTRAL' as const,
                reason: 'Стохастик в нейтральной зоне',
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
};

vi.mock('../../services/analysis.service', () => ({
    analyzeMarket: vi.fn(async () => mockAnalysis),
}));

import { analysisRoutes } from './analysis';
import { analyzeMarket } from '../../services/analysis.service';

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
        expect(analyzeMarket).toHaveBeenCalledTimes(1);

        await app.close();
    });
});
