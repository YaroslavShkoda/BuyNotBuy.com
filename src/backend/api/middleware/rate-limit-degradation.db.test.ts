import '../../test-support/test-database.js';

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { appConfig } from '../../config/app.config.js';
import { MetricRegistry, useRegistry } from '../../observability/registry.js';
import { getTestPool } from '../../test-support/test-database.js';

afterEach(() => { useRegistry(null); vi.restoreAllMocks(); });
beforeEach(async () => {
    await getTestPool().query('DELETE FROM rate_limit_window');
    // Keep recovery in the same fixed window even at a real minute boundary;
    // PostgreSQL and Fastify timers remain real.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_001_000);
});

describe('rate-limit store degradation against an isolated PostgreSQL schema', () => {
    it('passes requests, counts and logs each store failure, leaves probes reachable and resumes the shared budget after recovery', async () => {
        const metrics = new MetricRegistry();
        useRegistry(metrics);
        const logs: string[] = [];
        const stream = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
        const app = createApp(stream);
        const db = getTestPool();
        try {
            const before = await app.inject({ method: 'GET', url: '/' });
            expect(before.statusCode).toBe(200);
            expect(before.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - 1));
            // Rename only this file's private table; never stop a server or
            // change database-wide access. The real SQL upsert now fails.
            await db.query('ALTER TABLE rate_limit_window RENAME TO rate_limit_window_unavailable');
            try {
                for (const remoteAddress of ['198.51.100.10', '198.51.100.11']) {
                    const failedStore = await app.inject({ method: 'GET', url: '/', remoteAddress });
                    expect(failedStore.statusCode).toBe(200);
                    expect(failedStore.headers['x-ratelimit-remaining']).toBeUndefined();
                    expect(failedStore.headers['retry-after']).toBeUndefined();
                }
                const probe = await app.inject({ method: 'GET', url: '/metrics' });
                expect(probe.statusCode).toBe(200);
                expect(probe.body).toContain('buynotbuy_rate_limit_store_failures_total 2');
                expect(probe.body).not.toContain('buynotbuy_rate_limit_store_failures_total{');
                const events = logs.flatMap((chunk) => chunk.trim().split('\n').map((line) => JSON.parse(line) as { event?: string; level?: number }));
                const failures = events.filter((event) => event.event === 'rate_limit_store_failed');
                expect(failures).toHaveLength(2);
                expect(failures.every((event) => event.level === 50)).toBe(true);
            } finally {
                await db.query('ALTER TABLE rate_limit_window_unavailable RENAME TO rate_limit_window');
            }
            const recovered = await app.inject({ method: 'GET', url: '/' });
            expect(recovered.statusCode).toBe(200);
            expect(recovered.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - 2));
            expect(metrics.render({ namespace: 'buynotbuy_' })).toContain('buynotbuy_rate_limit_store_failures_total 2');
        } finally {
            await app.close();
        }
    });

    it('keeps forged forwarded addresses in the socket client budget', async () => {
        const app = createApp();
        try {
            const first = await app.inject({ method: 'GET', url: '/', remoteAddress: '192.0.2.8', headers: { 'x-forwarded-for': '203.0.113.1' } });
            const forged = await app.inject({ method: 'GET', url: '/', remoteAddress: '192.0.2.8', headers: { 'x-forwarded-for': '203.0.113.2', forwarded: 'for=203.0.113.3' } });
            expect(first.statusCode).toBe(200);
            expect(forged.statusCode).toBe(200);
            expect(forged.headers['x-ratelimit-remaining']).toBe(String(appConfig.rateLimitMax - 2));
            const buckets = await getTestPool().query<{ bucket: string }>('SELECT bucket FROM rate_limit_window');
            expect(buckets.rows).toEqual([{ bucket: '192.0.2.8' }]);
        } finally {
            await app.close();
        }
    });
});
