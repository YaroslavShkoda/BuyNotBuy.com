import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const mockAnalysis = {
    timestamp: 123456789,
    price: 80000,
    indicators: {
        ema300: 78000,
        stochastic: 20,
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

        expect(body.timestamp).toBe(123456789);
        expect(body.price).toBe(80000);

        expect(body.indicators.ema300).toBe(78000);
        expect(body.indicators.stochastic).toBe(20);

        expect(body.signal.signal).toBe('LONG');
        expect(body.signal.confidence).toBe(50);
        expect(body.signal.reason).toBe(
            'Только EMA 300 подтверждает LONG',
        );

        expect(body.signal.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'NEUTRAL',
                reason: 'Стохастик в нейтральной зоне',
            },
        ]);

        expect(body).toEqual(mockAnalysis);
        expect(analyzeMarket).toHaveBeenCalledTimes(1);

        await app.close();
    });
});
