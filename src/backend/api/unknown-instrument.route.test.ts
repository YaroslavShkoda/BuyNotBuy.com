import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '../errors/application.error.js';
import { registerErrorHandler } from './error-handler.js';
import { analysisRoutes } from './routes/analysis.js';
import { instrumentRoutes } from './routes/instruments.js';
import { marketRoutes } from './routes/market.js';

const { getMarket, getAnalysis } = vi.hoisted(() => ({ getMarket: vi.fn(), getAnalysis: vi.fn() }));
vi.mock('./controllers/market.controller.js', () => ({ getMarket }));
vi.mock('./controllers/analysis.controller.js', () => ({ getAnalysis }));
let app: FastifyInstance;
beforeEach(async () => {
    getMarket.mockReset();
    getAnalysis.mockReset();
    const unavailable = () => { throw new ApplicationError('upstream unavailable', { code: 'MARKET_PROVIDER_ERROR', statusCode: 502 }); };
    getMarket.mockImplementation(unavailable);
    getAnalysis.mockImplementation(unavailable);
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(instrumentRoutes);
    await app.register(marketRoutes);
    await app.register(analysisRoutes);
});
afterEach(async () => { await app.close(); });

describe('unknown instrument route boundary', () => {
    it.each(['market', 'analysis'])('returns 404 for unknown %s ticker before reaching its provider', async (endpoint) => {
        const response = await app.inject(`/api/instruments/UNKNOWN/${endpoint}`);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
        expect(getMarket).not.toHaveBeenCalled();
        expect(getAnalysis).not.toHaveBeenCalled();
    });
    it.each(['market', 'analysis'])('retains provider failure semantics for a known %s ticker', async (endpoint) => {
        const response = await app.inject(`/api/instruments/ethusdt/${endpoint}`);
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('MARKET_PROVIDER_ERROR');
        expect(endpoint === 'market' ? getMarket : getAnalysis).toHaveBeenCalledOnce();
    });
    it.each(['market', 'analysis'])('preserves the frozen /api/%s route provider failure', async (endpoint) => {
        const response = await app.inject(`/api/${endpoint}`);
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('MARKET_PROVIDER_ERROR');
        expect(endpoint === 'market' ? getMarket : getAnalysis).toHaveBeenCalledOnce();
    });
});
