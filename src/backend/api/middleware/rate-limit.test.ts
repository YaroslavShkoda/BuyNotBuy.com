import { describe, expect, it, vi } from 'vitest';

import {
    PostgresRateLimiter,
    type RateLimiterDatabase,
    rateLimitError,
} from './rate-limit.js';

const WINDOW_MS = 60_000;

/**
 * A database that only scripts what the upsert returns. The real semantics —
 * exclusivity of the count under concurrency — belong to Postgres, and are
 * pinned against the real thing in `rate-limit.db.test.ts`; a fake that
 * re-implemented the upsert would be testing a copy of it.
 */
function databaseReturning(count: number) {
    return {
        query: vi.fn(async () => ({ rows: [{ count }] })),
    };
}

describe('PostgresRateLimiter', () => {
    it('decides on the count the shared row reports', async () => {
        const database = databaseReturning(1);
        const limiter = new PostgresRateLimiter({
            max: 3,
            windowMs: WINDOW_MS,
            database: database as unknown as RateLimiterDatabase,
            now: () => 1_000,
        });

        // The window ends where the grid ends, not where the first request
        // was: second one into a sixty-second window still closes at sixty.
        await expect(limiter.consume('a')).resolves.toEqual({
            allowed: true,
            remaining: 2,
            resetAt: 60_000,
        });
    });

    it('denies once the shared count passes the limit, with nothing left', async () => {
        const database = databaseReturning(4);
        const limiter = new PostgresRateLimiter({
            max: 3,
            windowMs: WINDOW_MS,
            database: database as unknown as RateLimiterDatabase,
            now: () => 1_000,
        });

        await expect(limiter.consume('a')).resolves.toEqual({
            allowed: false,
            remaining: 0,
            resetAt: 60_000,
        });
    });

    it('writes to the aligned window, not to the first request', async () => {
        const database = databaseReturning(1);
        const limiter = new PostgresRateLimiter({
            max: 3,
            windowMs: WINDOW_MS,
            database: database as unknown as RateLimiterDatabase,
            now: () => 65_000,
        });

        await limiter.consume('a');

        // 65 seconds into a 60-second window: the row is the one that started
        // at 60. Every process derives the same value from the same wall
        // clock, which is what lands their writes on one row.
        expect(database.query).toHaveBeenCalledWith(
            expect.stringContaining('ON CONFLICT (bucket, window_start)'),
            ['a', 60_000],
        );
    });

    it('counts a rejected request too', async () => {
        const database = databaseReturning(5);
        const limiter = new PostgresRateLimiter({
            max: 3,
            windowMs: WINDOW_MS,
            database: database as unknown as RateLimiterDatabase,
            now: () => 1_000,
        });

        const decision = await limiter.consume('a');

        // The upsert has already run by the time the decision is read back.
        // A client hammering a closed window must not make `remaining` lie.
        expect(decision.allowed).toBe(false);
        expect(decision.remaining).toBe(0);
    });

    it('reset clears every window', async () => {
        const database = databaseReturning(1);
        const limiter = new PostgresRateLimiter({
            max: 3,
            windowMs: WINDOW_MS,
            database: database as unknown as RateLimiterDatabase,
        });

        await limiter.reset();

        expect(database.query).toHaveBeenCalledWith(
            'DELETE FROM rate_limit_window',
        );
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
