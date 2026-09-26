import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../../app.js';

import type { FastifyInstance } from 'fastify';

const temporaryDirectories: string[] = [];
const openInstances: FastifyInstance[] = [];

/**
 * Handles opened by a freshly re-imported module graph.
 *
 * `vi.resetModules()` gives a new registry, so the singletons the original
 * import created are not the ones a fresh app opened. Closing the wrong ones
 * leaves a SQLite handle open, and Windows then refuses to delete the
 * temporary directory — the next thing to fail is the cleanup, not the test.
 */
const foreignClosers: Array<() => void> = [];

function track(app: FastifyInstance): FastifyInstance {
    openInstances.push(app);

    return app;
}

/** Builds an app whose configuration is read from the current environment. */
async function appWithFreshModules(): Promise<FastifyInstance> {
    vi.resetModules();

    const fresh = await import('../../app.js');
    const history = await import('../../history/signal-history.repository.js');
    const votes = await import(
        '../../indicators/performance/indicator-vote.repository.js'
    );

    foreignClosers.push(
        history.closeSignalHistoryRepository,
        votes.closeIndicatorVoteRepository,
    );

    return track(fresh.createApp());
}

function temporaryFile(name: string, contents: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'health-'));
    temporaryDirectories.push(directory);

    const path = join(directory, name);
    writeFileSync(path, contents);

    return path;
}

function counterFrom(body: string, name: string): number {
    const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(body);

    if (match?.[1] === undefined) {
        throw new Error(`series ${name} is missing from the exposition`);
    }

    return Number(match[1]);
}

afterEach(async () => {
    while (openInstances.length > 0) {
        await openInstances.pop()?.close();
    }

    while (foreignClosers.length > 0) {
        foreignClosers.pop()?.();
    }

    while (temporaryDirectories.length > 0) {
        const directory = temporaryDirectories.pop();

        if (directory !== undefined) {
            rmSync(directory, { recursive: true, force: true });
        }
    }

    vi.unstubAllEnvs();
    vi.resetModules();
});

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
        const path = temporaryFile('garbage.db', 'this is not sqlite');

        vi.stubEnv('HISTORY_DB_PATH', path);

        const app = await appWithFreshModules();

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
        const path = temporaryFile('garbage.db', 'definitely not sqlite');

        vi.stubEnv('HISTORY_DB_PATH', path);

        const response = await (await appWithFreshModules()).inject({
            method: 'GET',
            url: '/readyz',
        });

        expect(response.statusCode).toBe(503);
        expect(response.json().status).toBe('not_ready');
        expect(response.json().checks.database.ok).toBe(false);
        expect(typeof response.json().checks.database.detail).toBe('string');
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
