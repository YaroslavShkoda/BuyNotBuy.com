import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(async () => ({
            symbol: 'BTCUSDT',
            price: 80000,
        })),
        getCandles: vi.fn(async (limit = 900) =>
            Array.from({ length: Math.max(0, limit - 1) }, (_, index) => {
                const hour = 3_600_000;
                const now = Date.now();

                return {
                    timestamp: now - (limit - 1 - index) * hour,
                    open: 100 + index,
                    high: 102 + index,
                    low: 98 + index,
                    close: 100 + index,
                    volume: 1000,
                };
            }),
        ),
    },
}));

vi.mock('../../market/market.provider.js', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

vi.mock('../../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from '../../app.js';
import { appConfig } from '../../config/app.config.js';
import { marketConfig } from '../../config/market.config.js';
import { rateLimiter } from './rate-limit.plugin.js';
import { resetMarketDataCache } from '../../market/market.service.js';

beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter.reset();
    resetMarketDataCache();
});

describe('HTTP hardening', () => {
    describe('security headers', () => {
        it('sets the full header set on a normal response', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.headers['x-content-type-options']).toBe('nosniff');
            expect(response.headers['x-frame-options']).toBe('DENY');
            expect(response.headers['cross-origin-resource-policy']).toBe(
                'same-origin',
            );
            expect(response.headers['referrer-policy']).toBe('no-referrer');
            expect(response.headers['content-security-policy']).toContain(
                "default-src 'none'",
            );
            expect(response.headers['content-security-policy']).toContain(
                "frame-ancestors 'none'",
            );
            expect(response.headers['permissions-policy']).toContain(
                'geolocation=()',
            );

            await app.close();
        });

        it('sets the headers on an error response too', async () => {
            mockMarketDataProvider.getPrice.mockRejectedValueOnce(
                new Error('boom'),
            );

            const app = createApp();

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.statusCode).toBeGreaterThanOrEqual(500);
            // A failed response still carries no sniffable, framable content.
            expect(response.headers['x-content-type-options']).toBe('nosniff');
            expect(response.headers['x-frame-options']).toBe('DENY');

            await app.close();
        });

        it('does not leak the server implementation', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.headers['x-powered-by']).toBeUndefined();

            await app.close();
        });

        it('omits HSTS while the service is served over plain HTTP', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            // HSTS over HTTP is ignored by browsers, and pinning localhost
            // would make local development painful.
            expect(appConfig.hstsMaxAgeSeconds).toBe(0);
            expect(
                response.headers['strict-transport-security'],
            ).toBeUndefined();

            await app.close();
        });
    });

    describe('CORS', () => {
        it('sends no allow-origin header to an unlisted origin', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
                headers: { origin: 'https://evil.example' },
            });

            // The browser blocks the read; nothing here invites it in.
            expect(
                response.headers['access-control-allow-origin'],
            ).toBeUndefined();

            await app.close();
        });

        it('always varies on Origin so a cache cannot mix decisions', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.headers['vary']).toBe('Origin');

            await app.close();
        });

        it('answers a preflight for an unlisted origin without allowing it', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'OPTIONS',
                url: '/api/price',
                headers: {
                    origin: 'https://evil.example',
                    'access-control-request-method': 'GET',
                },
            });

            expect(response.statusCode).toBe(204);
            expect(
                response.headers['access-control-allow-origin'],
            ).toBeUndefined();

            await app.close();
        });

        it('answers a preflight for the root path without a route existing', async () => {
            const app = createApp();

            const response = await app.inject({
                method: 'OPTIONS',
                url: '/anything/at/all',
            });

            expect(response.statusCode).toBe(204);

            await app.close();
        });
    });

    describe('rate limiting', () => {
        it('answers with 429 and a wait once the allowance is spent', async () => {
            const app = createApp();

            let limited: Awaited<ReturnType<typeof app.inject>> | undefined;

            for (let index = 0; index < appConfig.rateLimitMax + 1; index += 1) {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/price',
                });

                if (response.statusCode === 429) {
                    limited = response;
                    break;
                }
            }

            expect(limited).toBeDefined();
            expect(limited?.json()).toEqual({
                error: {
                    code: 'RATE_LIMITED',
                    message: 'Too many requests',
                },
            });

            await app.close();
        });

        it('tells the client when to come back', async () => {
            const app = createApp();

            for (let index = 0; index < appConfig.rateLimitMax; index += 1) {
                await app.inject({ method: 'GET', url: '/api/price' });
            }

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.statusCode).toBe(429);
            expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);

            await app.close();
        });

        it('advertises the remaining allowance on every response', async () => {
            const app = createApp();

            const first = await app.inject({ method: 'GET', url: '/api/price' });
            const second = await app.inject({ method: 'GET', url: '/api/price' });

            expect(first.headers['x-ratelimit-limit']).toBe(
                String(appConfig.rateLimitMax),
            );
            expect(Number(second.headers['x-ratelimit-remaining'])).toBe(
                Number(first.headers['x-ratelimit-remaining']) - 1,
            );

            await app.close();
        });

        it('limits an abusive client without touching anyone else', async () => {
            const app = createApp();

            for (let index = 0; index <= appConfig.rateLimitMax; index += 1) {
                await app.inject({
                    method: 'GET',
                    url: '/api/price',
                    remoteAddress: '10.0.0.1',
                });
            }

            const blocked = await app.inject({
                method: 'GET',
                url: '/api/price',
                remoteAddress: '10.0.0.1',
            });

            const other = await app.inject({
                method: 'GET',
                url: '/api/price',
                remoteAddress: '10.0.0.2',
            });

            // One noisy client must not be able to spend everyone else's quota.
            expect(blocked.statusCode).toBe(429);
            expect(other.statusCode).toBe(200);

            await app.close();
        });

        it('does not consume allowance on a request it refuses', async () => {
            const app = createApp();

            for (let index = 0; index < appConfig.rateLimitMax; index += 1) {
                await app.inject({
                    method: 'GET',
                    url: '/api/price',
                    remoteAddress: '10.0.0.3',
                });
            }

            const refused = await app.inject({
                method: 'GET',
                url: '/api/price',
                remoteAddress: '10.0.0.3',
            });

            expect(refused.statusCode).toBe(429);

            // The counter must not keep climbing past the limit, or a client
            // would stay blocked for far longer than one window.
            expect(
                Number(refused.headers['x-ratelimit-remaining']),
            ).toBe(0);

            await app.close();
        });
    });

    describe('request size', () => {
        it('refuses a body larger than the configured limit', async () => {
            // A standalone instance carrying the same limit, because the real
            // app only exposes read routes and there is nothing to send a
            // body to.
            const app = Fastify({ bodyLimit: appConfig.bodyLimitBytes });

            app.post('/echo', async () => ({ ok: true }));

            const response = await app.inject({
                method: 'POST',
                url: '/echo',
                headers: { 'content-type': 'application/json' },
                payload: JSON.stringify({
                    blob: 'x'.repeat(appConfig.bodyLimitBytes + 1024),
                }),
            });

            // Rejected before the handler runs, so an oversized body never
            // reaches a route or sits in a parsed object.
            expect(response.statusCode).toBe(413);

            await app.close();
        });

        it('still accepts a body within the limit', async () => {
            const app = Fastify({ bodyLimit: appConfig.bodyLimitBytes });

            app.post('/echo', async () => ({ ok: true }));

            const response = await app.inject({
                method: 'POST',
                url: '/echo',
                payload: { note: 'ok' },
            });

            expect(response.statusCode).toBe(200);

            await app.close();
        });

        it('keeps the limit small enough that a body is never a memory risk', () => {
            // The API accepts no bodies at all, so the limit only needs to
            // leave room for something reasonable later.
            expect(appConfig.bodyLimitBytes).toBeLessThanOrEqual(64 * 1024);
        });
    });

    describe('timeouts', () => {
        it('gives the transport room to finish every retry before cutting off', () => {
            const worstCase =
                (marketConfig.maxRetries + 1) * marketConfig.requestTimeoutMs +
                marketConfig.maxRetries * marketConfig.retryMaxDelayMs;

            // Otherwise the server would kill a request the market transport
            // was about to answer, turning a slow provider into a failed one.
            expect(appConfig.requestTimeoutMs).toBeGreaterThan(worstCase);
        });

        it('applies the configured timeouts to the server', async () => {
            const app = createApp();

            expect(app.initialConfig.connectionTimeout).toBe(
                appConfig.connectionTimeoutMs,
            );
            expect(app.initialConfig.keepAliveTimeout).toBe(
                appConfig.keepAliveTimeoutMs,
            );
            expect(app.initialConfig.bodyLimit).toBe(appConfig.bodyLimitBytes);
            expect(
                (app.server as { requestTimeout?: number }).requestTimeout,
            ).toBe(appConfig.requestTimeoutMs);

            await app.close();
        });

        it('does not believe a client-supplied forwarding header by default', async () => {
            const app = createApp();

            // Trusting X-Forwarded-For without a proxy that overwrites it would
            // let any client claim a fresh address past the rate limit. Two
            // requests with different claimed addresses must therefore share
            // one budget.
            const plain = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            const spoofed = await app.inject({
                method: 'GET',
                url: '/api/price',
                headers: { 'x-forwarded-for': '203.0.113.9' },
            });

            const plainRemaining = Number(
                plain.headers['x-ratelimit-remaining'],
            );
            const spoofedRemaining = Number(
                spoofed.headers['x-ratelimit-remaining'],
            );

            expect(spoofedRemaining).toBe(plainRemaining - 1);
            expect(appConfig.trustProxy).toBe(false);

            await app.close();
        });
    });
});
