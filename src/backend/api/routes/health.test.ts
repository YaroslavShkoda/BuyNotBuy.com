import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { resetMetrics } from '../lib/metrics.js';
import { LATEST_SCHEMA_VERSION } from '../../db/migrations.js';

import type { FastifyInstance } from 'fastify';

/**
 * The database is replaced, not broken.
 *
 * There is no database file to point at a piece of garbage any more. What "the
 * database is unusable" means is now a set of answers the server can give — it
 * refuses the connection, it holds a schema this build cannot read, a table is
 * missing — and each of those is a state a mock can be put into directly. It
 * also stops the probe tests from depending on a server being up in order to
 * observe it being unreachable.
 */
const { historyRepository, voteRepository } = vi.hoisted(() => ({
    historyRepository: {
        schemaVersion: vi.fn(),
        record: vi.fn(),
        list: vi.fn(),
        durabilitySettings: vi.fn(),
    },
    voteRepository: {
        count: vi.fn(),
    },
}));

// Both modules reach the database through these two getters, and the
// repositories they hand out are now entirely asynchronous.
vi.mock('../../history/signal-history.repository.js', () => ({
    getSignalHistoryRepository: () => historyRepository,
}));

vi.mock('../../indicators/performance/indicator-vote.repository.js', () => ({
    getIndicatorVoteRepository: () => voteRepository,
}));

const openInstances: FastifyInstance[] = [];

function track(app: FastifyInstance): FastifyInstance {
    openInstances.push(app);

    return app;
}

beforeEach(() => {
    // A database this build understands, with nothing recorded in it.
    historyRepository.schemaVersion.mockResolvedValue(LATEST_SCHEMA_VERSION);
    historyRepository.record.mockResolvedValue(undefined);
    historyRepository.list.mockResolvedValue([]);
    historyRepository.durabilitySettings.mockResolvedValue({
        statementTimeout: '10s',
        lockTimeout: '5s',
    });
    voteRepository.count.mockResolvedValue(0);

    // The counters are a module singleton. Without this, a 503 from a
    // readiness test above would be counted as a failure by a metrics test
    // below, which asserts on an exact number.
    resetMetrics();
});

afterEach(async () => {
    while (openInstances.length > 0) {
        await openInstances.pop()?.close();
    }
});

function counterFrom(body: string, name: string): number {
    const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(body);

    if (match?.[1] === undefined) {
        throw new Error(`series ${name} is missing from the exposition`);
    }

    return Number(match[1]);
}

describe('liveness', () => {
    it('answers plainly', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/healthz',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok' });
    });

    it('stays up when the database is unreadable', async () => {
        historyRepository.schemaVersion.mockRejectedValue(
            new Error('connect ECONNREFUSED 127.0.0.1:5432'),
        );

        const app = track(createApp());

        const live = await app.inject({ method: 'GET', url: '/healthz' });
        const ready = await app.inject({ method: 'GET', url: '/readyz' });

        // A liveness probe that also asks the database restarts the process
        // when the database is down, turning a dependency's outage into a
        // crash loop and destroying the evidence in the process. Readiness is
        // where that failure belongs.
        expect(live.statusCode).toBe(200);
        expect(ready.statusCode).toBe(503);
    });
});

describe('readiness', () => {
    it('is ready when the database answers', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            status: 'ready',
            checks: { database: { ok: true } },
        });
    });

    it('says what failed rather than only that something did', async () => {
        historyRepository.schemaVersion.mockRejectedValue(
            new Error('password authentication failed for user "buynotbuy"'),
        );

        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        expect(response.statusCode).toBe(503);
        expect(response.json().status).toBe('not_ready');
        expect(response.json().checks.database.ok).toBe(false);
        expect(typeof response.json().checks.database.detail).toBe('string');
        // The server's own words: "the database is unusable" is not enough to
        // tell a wrong password from a wrong host.
        expect(response.json().checks.database.detail).toContain(
            'password authentication failed',
        );
    });

    it('refuses a database written by a newer build', async () => {
        historyRepository.schemaVersion.mockResolvedValue(
            LATEST_SCHEMA_VERSION + 1,
        );

        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        // Serving it would mean writing rows into a schema this build reads
        // wrongly, which is not something a probe can recover from.
        expect(response.statusCode).toBe(503);
        expect(response.json().checks.database.detail).toContain(
            `v${LATEST_SCHEMA_VERSION + 1}`,
        );
    });

    it('reports an unreadable vote table as not ready', async () => {
        voteRepository.count.mockRejectedValue(
            new Error('relation "indicator_vote" does not exist'),
        );

        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        // The vote store is a second table in the same database, and the
        // readiness check reads it for exactly this reason: otherwise a
        // missing table surfaces as a silent no-op on the first write.
        expect(response.statusCode).toBe(503);
        expect(response.json().checks.database.ok).toBe(false);
        expect(response.json().checks.database.detail).toContain(
            'indicator_vote',
        );
    });
});

describe('request ids', () => {
    it('echoes an id back to the caller', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/healthz',
            headers: { 'x-request-id': 'trace-42' },
        });

        // Echoed so a caller can find their own request in the log.
        expect(response.headers['x-request-id']).toBe('trace-42');
    });

    it('ignores an id that would forge a log line', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/healthz',
            headers: { 'x-request-id': 'a'.repeat(500) },
        });

        // Refusing the request would let anyone who can set a header decide
        // whether the API works; ignoring the value does not.
        expect(response.statusCode).toBe(200);
        expect(response.headers['x-request-id']).toBeUndefined();
    });

    it('echoes an id on a normal request too', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/api/signal-history',
            headers: { 'x-request-id': 'trace-7' },
        });

        expect(response.headers['x-request-id']).toBe('trace-7');
    });
});

describe('metrics endpoint', () => {
    it('serves the text exposition format', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/metrics',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/plain');
        expect(response.body).toContain('buynotbuy_uptime_seconds');
    });

    it('reflects the requests it has served', async () => {
        const app = track(createApp());

        const before = counterFrom(
            (await app.inject({ method: 'GET', url: '/metrics' })).body,
            'buynotbuy_requests_total',
        );

        await app.inject({ method: 'GET', url: '/healthz' });
        await app.inject({ method: 'GET', url: '/healthz' });

        const after = counterFrom(
            (await app.inject({ method: 'GET', url: '/metrics' })).body,
            'buynotbuy_requests_total',
        );

        // Three more requests: the two probes and the scrape that read the
        // number, which is counted as it is served.
        expect(after).toBe(before + 3);
    });

    it('counts a failure without counting a success as one', async () => {
        const app = track(createApp());

        await app.inject({ method: 'GET', url: '/api/signal-history?limit=abc' });
        await app.inject({ method: 'GET', url: '/healthz' });

        const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

        expect(counterFrom(body, 'buynotbuy_request_failures_total')).toBe(1);
    });

    it('is answerable while the real endpoints are being hammered', async () => {
        const app = track(createApp());

        for (let i = 0; i < 40; i += 1) {
            await app.inject({ method: 'GET', url: '/api/signal-history?limit=abc' });
        }

        // A load balancer polling a rate-limited probe would take every
        // instance out of rotation at once: the probe traffic alone would be
        // what broke it.
        expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    });
});
