// Before any other import, and for its side effects: this suite now exercises
// the real rate-limit counter, which lives in the database, and the per-file
// schema has to exist — and own the connection string — before the pool
// modules are evaluated.
import '../../test-support/test-database.js';

import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    const base = {
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
    };

    return {
        mockAnyProviderAvailable: vi.fn(() => true),
        mockMarketDataProvider: {
            ...base,
            getAttributedCandles: vi.fn(async (limit?: number) => ({
                venue: 'binance',
                symbol: 'BTCUSDT',                interval: '1h',
                candles: await base.getCandles(limit),
            })),
        },
    };
});

vi.mock('../../market/market.provider.js', () => ({
    // The router hands the service a provider for the market it was asked
    // about. Every test here has one market, so it hands back the one stub —
    // the routing itself is exercised in capability.test.ts, where a wrong
    // answer is a property failure rather than a mistyped URL.
    marketProviderFor: () => mockMarketDataProvider,
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
}));

vi.mock('../../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from '../../app.js';
import { appConfig } from '../../config/app.config.js';
import { marketConfig } from '../../config/market.config.js';
import { resetMarketDataCache } from '../../market/market.service.js';
import { rateLimiter } from './rate-limit.repository.js';

const originalDateNow = Date.now;
const FIXED_NOW = 1_800_000_001_000;
let now = FIXED_NOW;
let restoreClock = () => {};

beforeEach(async () => {
    // Only the wall-clock reading is controlled: Fastify, PostgreSQL and
    // asynchronous operations keep their real timers.
    now = FIXED_NOW;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    restoreClock = () => clock.mockRestore();
    vi.clearAllMocks();
    await rateLimiter.reset();
    resetMarketDataCache();
});

afterEach(() => {
    restoreClock();
    expect(Date.now).toBe(originalDateNow);
});

async function fillAllowance(app: ReturnType<typeof createApp>, remoteAddress = '127.0.0.1') {
    const reset = String(Math.ceil(
        (Math.floor(now / appConfig.rateLimitWindowMs) + 1) * appConfig.rateLimitWindowMs / 1000,
    ));
    for (let index = 0; index < appConfig.rateLimitMax; index += 1) {
        const response = await app.inject({ method: 'GET', url: '/api/price', remoteAddress });
        expect(response.statusCode).toBe(200);
        expect(response.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - index - 1));
        expect(response.headers['x-ratelimit-reset']).toBe(reset);
    }
    return reset;
}

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

            await fillAllowance(app);
            const limited = await app.inject({ method: 'GET', url: '/api/price' });

            expect(limited.statusCode).toBe(429);
            expect(limited.json()).toEqual({
                error: {
                    code: 'RATE_LIMITED',
                    message: 'Too many requests',
                },
            });

            await app.close();
        }, 30_000);

        it('tells the client when to come back', async () => {
            const app = createApp();

            await fillAllowance(app);

            const response = await app.inject({
                method: 'GET',
                url: '/api/price',
            });

            expect(response.statusCode).toBe(429);
            expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);

            await app.close();
        }, 30_000);

        it('advertises the remaining allowance on every response', async () => {
            const app = createApp();

            const first = await app.inject({ method: 'GET', url: '/api/price' });
            const second = await app.inject({ method: 'GET', url: '/api/price' });

            expect(first.statusCode).toBe(200);
            expect(second.statusCode).toBe(200);
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

            await fillAllowance(app, '10.0.0.1');

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
            expect(other.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - 1));

            await app.close();
        }, 30_000);

        it('keeps remaining allowance zero and the reset unchanged after repeated refusals', async () => {
            const app = createApp();
            try {
                const reset = await fillAllowance(app, '10.0.0.3');
                // Rejected requests may keep increasing the SQL counter. They
                // neither make remaining negative nor extend this fixed window.
                for (let index = 0; index < 3; index += 1) {
                    const refused = await app.inject({
                        method: 'GET', url: '/api/price', remoteAddress: '10.0.0.3',
                    });
                    expect(refused.statusCode).toBe(429);
                    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
                    expect(refused.headers['x-ratelimit-reset']).toBe(reset);
                }
            } finally {
                await app.close();
            }
        }, 30_000);

        it('renews the budget exactly at the next fixed-window boundary', async () => {
            expect(appConfig.rateLimitWindowMs).toBe(60_000);
            now = 59_999;
            const app = createApp();
            try {
                expect(await fillAllowance(app, '10.0.0.3')).toBe('60');
                const refused = await app.inject({ method: 'GET', url: '/api/price', remoteAddress: '10.0.0.3' });
                expect(refused.statusCode).toBe(429);
                expect(refused.headers['x-ratelimit-remaining']).toBe('0');
                now = 60_000;
                const renewed = await app.inject({ method: 'GET', url: '/api/price', remoteAddress: '10.0.0.3' });
                expect(renewed.statusCode).toBe(200);
                expect(renewed.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - 1));
                expect(renewed.headers['x-ratelimit-reset']).toBe('120');
            } finally {
                await app.close();
            }
        }, 30_000);

        it('shares one client budget between application instances', async () => {
            const first = createApp();
            const second = createApp();
            try {
                for (let index = 0; index < appConfig.rateLimitMax; index += 1) {
                    const app = index % 2 === 0 ? first : second;
                    const response = await app.inject({ method: 'GET', url: '/api/price', remoteAddress: '10.0.0.3' });
                    expect(response.statusCode).toBe(200);
                    expect(response.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - index - 1));
                }
                for (const app of [first, second]) {
                    const refused = await app.inject({ method: 'GET', url: '/api/price', remoteAddress: '10.0.0.3' });
                    expect(refused.statusCode).toBe(429);
                    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
                }
            } finally {
                await first.close();
                await second.close();
            }
        }, 30_000);

        it('fails open and logs a diagnostic event when the rate-limit store fails', async () => {
            const lines: string[] = [];
            const sink = new Writable({
                write(chunk, _encoding, callback) {
                    lines.push(chunk.toString());
                    callback();
                },
            });
            const app = createApp(sink);
            const consume = vi.spyOn(rateLimiter, 'consume').mockRejectedValueOnce(new Error('rate-limit store unavailable'));
            try {
                const response = await app.inject({ method: 'GET', url: '/api/price' });
                expect(response.statusCode).toBe(200);
                expect(response.headers['x-ratelimit-limit']).toBeUndefined();
                const entries = lines.join('').split('\n').filter(Boolean)
                    .map((line) => JSON.parse(line) as { event?: string; level?: number; err?: { message?: string } });
                expect(entries).toContainEqual(expect.objectContaining({
                    event: 'rate_limit_store_failed', level: 50,
                    err: expect.objectContaining({ message: 'rate-limit store unavailable' }),
                }));
                const recovered = await app.inject({ method: 'GET', url: '/api/price' });
                expect(recovered.statusCode).toBe(200);
                expect(recovered.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - 1));
            } finally {
                consume.mockRestore();
                await app.close();
            }
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

            expect(plain.statusCode).toBe(200);
            expect(spoofed.statusCode).toBe(200);
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
