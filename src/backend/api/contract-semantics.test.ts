import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

// The analysis route is exercised for real, but its controller is stubbed:
// these tests are about headers and routing, and a live provider call would
// make them depend on a network that is not part of the contract.
const { mockGetAnalysis, mockGetMarket } = vi.hoisted(() => ({
    mockGetAnalysis: vi.fn(),
    mockGetMarket: vi.fn(),
}));

vi.mock('./controllers/analysis.controller.js', () => ({ getAnalysis: mockGetAnalysis }));
vi.mock('./controllers/market.controller.js', () => ({ getMarket: mockGetMarket }));

import { createApp } from '../app.js';
import { registerErrorHandler } from './error-handler.js';
import { ApiErrorResponseSchema } from './schemas.js';

import type { FastifyInstance } from 'fastify';

const openInstances: FastifyInstance[] = [];

const ANALYSIS = {
    timestamp: 1_737_950_400_000,
    price: 100_000,
    indicators: { ema300: 99_000, stochastic: 12, momentum: 0.4 },
    signal: {
        signal: 'LONG',
        confidence: 61,
        reason: 'предложенный набор',
        indicators: [
            { name: 'EMA 300', signal: 'LONG', reason: 'a', weight: 0.8 },
        ],
    },
    momentum: { period: 100, current: 0.4, series: [0.1, 0.4] },
    divergence: { bullish: null, bearish: null },
};

async function tracked(app: FastifyInstance): Promise<FastifyInstance> {
    openInstances.push(app);

    return app;
}

beforeEach(() => {
    mockGetAnalysis.mockReset();
    mockGetAnalysis.mockResolvedValue({ payload: ANALYSIS, stale: false, ageMs: 1_000 });
    mockGetMarket.mockReset();
    mockGetMarket.mockResolvedValue({
        payload: { price: { symbol: 'BTCUSDT', price: 100_000 }, candles: [] },
        stale: false,
        ageMs: 1_000,
    });
});

/**
 * A stand-in for the routes that accept a body.
 *
 * Fastify's own body parsing is where a client's mistake is raised, and there
 * is no such route in production, so the behaviour is exercised on an instance
 * that has the same error handling and nothing else. Adding a test-only route
 * to the real app would mean shipping a hole in it forever.
 */
async function appWithBodyRoute(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });

    registerErrorHandler(app);

    app.post('/echo', async (request) => request.body);

    return tracked(app);
}

afterEach(async () => {
    while (openInstances.length > 0) {
        await openInstances.pop()?.close();
    }
});

describe('error envelope', () => {
    it('answers an unknown route in the same shape as every other error', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'GET', url: '/api/nope' });

        expect(response.statusCode).toBe(404);

        // Fastify's default is `{"message":"Route ... not found","statusCode":404}`
        // with no code at all, which forces every client to special-case
        // exactly one endpoint.
        const parsed = ApiErrorResponseSchema.safeParse(response.json());

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.error.code).toBe('NOT_FOUND');
        expect(response.body).not.toContain('Route GET');
    });

    it('answers an unknown path under a known prefix the same way', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'GET', url: '/api/analysis/extra' });

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('NOT_FOUND');
    });

    it('answers an unsupported method as 404 rather than inventing one', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'POST', url: '/api/analysis' });

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('NOT_FOUND');
    });

    it('rejects a malformed JSON body as a client error, not a server one', async () => {
        const app = await appWithBodyRoute();

        const response = await app.inject({
            method: 'POST',
            url: '/echo',
            payload: '{not json',
            headers: { 'content-type': 'application/json' },
        });

        // A body the client got wrong must not be reported as our outage: it
        // tells the client to fix its request and tells every dashboard that
        // the service is healthy.
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
    });

    it('rejects a body sent with an unsupported content type as 415', async () => {
        const app = await appWithBodyRoute();

        const response = await app.inject({
            method: 'POST',
            url: '/echo',
            payload: '<xml />',
            headers: { 'content-type': 'application/xml' },
        });

        expect(response.statusCode).toBe(415);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
    });

    it('rejects an empty body where one is required', async () => {
        const app = await appWithBodyRoute();

        const response = await app.inject({
            method: 'POST',
            url: '/echo',
            payload: '',
            headers: { 'content-type': 'application/json' },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
    });

    it('never lets a 4xx from inside a handler become a client error', async () => {
        const app = Fastify({ logger: false });

        registerErrorHandler(app);

        app.get('/wrong', async () => {
            const error = new Error('miscomputed 409') as Error & {
                statusCode: number;
            };

            // A status borrowed from inside a handler is usually our own
            // miscalculation, so it is not promoted to a client error here.
            error.statusCode = 409;

            throw error;
        });

        await tracked(app).then(async (trackedApp) => {
            const response = await trackedApp.inject({ method: 'GET', url: '/wrong' });

            expect(response.statusCode).toBe(500);
            expect(response.json().error.code).toBe('INTERNAL_ERROR');
            expect(response.body).not.toContain('miscomputed');
        });
    });
});

describe('conditional GET', () => {
    it('sends a tag with the analysis', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'GET', url: '/api/analysis' });

        // Weak, because the body carries a timestamp that moves on every read
        // and the tag deliberately ignores it.
        expect(response.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
        expect(response.headers['cache-control']).toContain('max-age=30');
    });
    it('answers 304 when the client already has that exact body', async () => {
        const app = await tracked(createApp());

        const first = await app.inject({ method: 'GET', url: '/api/analysis' });
        const second = await app.inject({
            method: 'GET',
            url: '/api/analysis',
            headers: { 'if-none-match': first.headers.etag as string },
        });

        expect(second.statusCode).toBe(304);
        expect(second.body).toBe('');
    });

    it('still says how fresh the data is when it sends no body', async () => {
        const app = await tracked(createApp());

        const first = await app.inject({ method: 'GET', url: '/api/analysis' });
        const second = await app.inject({
            method: 'GET',
            url: '/api/analysis',
            headers: { 'if-none-match': first.headers.etag as string },
        });

        // A client that skipped the body has lost nothing else. Without these
        // it could not tell "unchanged and fresh" from "unchanged and stale".
        expect(second.headers['x-data-stale']).toBeDefined();
        expect(second.headers['x-data-age-ms']).toBeDefined();
    });

    it('sends the body when the tag does not match', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({
            method: 'GET',
            url: '/api/analysis',
            headers: { 'if-none-match': '"outdated"' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.body.length).toBeGreaterThan(0);
    });

    it('answers 304 when the market itself has not moved', async () => {
        const app = await tracked(createApp());

        const first = await app.inject({ method: 'GET', url: '/api/analysis' });

        // The analysis stamps the moment it was computed into its own body,
        // so a second read differs in that one field.
        mockGetAnalysis.mockResolvedValue({
            payload: { ...ANALYSIS, timestamp: ANALYSIS.timestamp + 5_000 },
            stale: false,
            ageMs: 6_000,
        });

        const second = await app.inject({
            method: 'GET',
            url: '/api/analysis',
            headers: { 'if-none-match': first.headers.etag as string },
        });

        // Hashing the whole body would make every request a fresh tag and the
        // client would never see one of these.
        expect(first.headers.etag).toBe(second.headers.etag);
        expect(second.statusCode).toBe(304);
    });

    it('does not answer 304 when the signal actually changed', async () => {
        const app = await tracked(createApp());

        const first = await app.inject({ method: 'GET', url: '/api/analysis' });

        mockGetAnalysis.mockResolvedValue({
            payload: {
                ...ANALYSIS,
                signal: { ...ANALYSIS.signal, signal: 'SHORT', confidence: 70 },
            },
            stale: false,
            ageMs: 6_000,
        });

        const second = await app.inject({
            method: 'GET',
            url: '/api/analysis',
            headers: { 'if-none-match': first.headers.etag as string },
        });

        expect(second.statusCode).toBe(200);
        expect(second.json().signal.signal).toBe('SHORT');
    });

    it('sends a tag with the market snapshot too', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'GET', url: '/api/market' });

        expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    });

    it('leaves the caching policy to the freshness layer', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'GET', url: '/api/analysis' });

        // Fresh data is cacheable, and that is the freshness layer's call, not
        // the conditional layer's: two owners of one header is how a stale
        // response quietly becomes cacheable again.
        expect(response.headers['cache-control']).toBe('public, max-age=30');
    });

    it('never lets a stale answer become cacheable through a 304', async () => {
        const app = await tracked(createApp());

        mockGetAnalysis.mockResolvedValue({
            payload: ANALYSIS,
            stale: true,
            ageMs: 600_000,
        });

        const first = await app.inject({ method: 'GET', url: '/api/analysis' });
        const second = await app.inject({
            method: 'GET',
            url: '/api/analysis',
            headers: { 'if-none-match': first.headers.etag as string },
        });

        expect(first.headers.etag).toBe(second.headers.etag);
        // The bytes are identical, so a 304 is correct — but the client must
        // still be told the answer behind it is a repeated snapshot.
        expect(second.statusCode).toBe(304);
        expect(second.headers['cache-control']).toBe('no-store');
        expect(second.headers['x-data-stale']).toBe('true');
    });
});

describe('history pagination', () => {
    it('reports no cursor at the end of the record', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({ method: 'GET', url: '/api/signal-history' });

        expect(response.statusCode).toBe(200);
        expect(response.json().nextCursor).toBeNull();
    });

    it('rejects a cursor it did not issue', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?cursor=forged',
        });

        // Silently serving the newest page would look exactly like a
        // duplicated history to whoever asked for an older one.
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
    });

    it('rejects an empty cursor', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?cursor=',
        });

        expect(response.statusCode).toBe(400);
    });

    it('keeps working without a cursor at all', async () => {
        const app = await tracked(createApp());

        const response = await app.inject({
            method: 'GET',
            url: '/api/signal-history?limit=24',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveProperty('summary');
        expect(response.json().entries.length).toBeLessThanOrEqual(24);
    });
});
