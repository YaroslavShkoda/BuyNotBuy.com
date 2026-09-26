import { describe, expect, it } from 'vitest';

import { FixedWindowRateLimiter, rateLimitError } from './rate-limit.js';

const WINDOW_MS = 60_000;

function limiterAt(now: () => number, max = 3, windowMs = WINDOW_MS) {
    return new FixedWindowRateLimiter({ max, windowMs, now });
}

describe('FixedWindowRateLimiter', () => {
    it('allows exactly the configured number of requests per window', () => {
        const limiter = limiterAt(() => 0);

        for (let index = 0; index < 3; index += 1) {
            expect(limiter.consume('a').allowed).toBe(true);
        }

        expect(limiter.consume('a').allowed).toBe(false);
    });

    it('counts down the remaining allowance', () => {
        const limiter = limiterAt(() => 0);

        expect(limiter.consume('a').remaining).toBe(2);
        expect(limiter.consume('a').remaining).toBe(1);
        expect(limiter.consume('a').remaining).toBe(0);
        expect(limiter.consume('a').remaining).toBe(0);
    });

    it('counts each client separately', () => {
        const limiter = limiterAt(() => 0, 1);

        expect(limiter.consume('a').allowed).toBe(true);
        expect(limiter.consume('b').allowed).toBe(true);
        expect(limiter.consume('a').allowed).toBe(false);
    });

    it('starts a fresh window once the old one has passed', () => {
        let now = 0;
        const limiter = limiterAt(() => now, 1);

        expect(limiter.consume('a').allowed).toBe(true);
        expect(limiter.consume('a').allowed).toBe(false);

        now = WINDOW_MS;

        expect(limiter.consume('a').allowed).toBe(true);
    });

    it('reports when the window ends', () => {
        let now = 1_000;
        const limiter = limiterAt(() => now, 1);

        expect(limiter.consume('a').resetAt).toBe(1_000 + WINDOW_MS);
    });

    it('drops expired windows so the map cannot grow without bound', () => {
        let now = 0;
        // A ten-millisecond window imitates a flood from rotating sources:
        // every client is long gone by the time the next one arrives.
        const limiter = limiterAt(() => now, 1, 10);

        for (let index = 0; index < 3000; index += 1) {
            limiter.consume(`client-${index}`);
            now += 1;
        }

        // Without the sweep the map would hold one entry per address ever seen.
        expect(limiter.size).toBeLessThanOrEqual(1001);
    });

    it('reset clears every window', () => {
        const limiter = limiterAt(() => 0, 1);

        limiter.consume('a');
        limiter.reset();

        expect(limiter.size).toBe(0);
        expect(limiter.consume('a').allowed).toBe(true);
    });
});

describe('rateLimitError', () => {
    it('carries 429 and a wait the client can act on', () => {
        const error = rateLimitError(30);

        expect(error.statusCode).toBe(429);
        expect(error.retryAfterSeconds).toBe(30);
        expect(error.code).toBe('RATE_LIMITED');
    });

    it('never advertises a wait of zero seconds', () => {
        // `Retry-After: 0` invites an immediate retry, which is the opposite
        // of what a rate limit is for.
        expect(rateLimitError(0).retryAfterSeconds).toBe(1);
        expect(rateLimitError(-5).retryAfterSeconds).toBe(1);
    });
});
