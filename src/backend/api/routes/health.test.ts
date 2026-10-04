import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { LATEST_SCHEMA_VERSION } from '../../db/migrations.js';
import { createHealthRegistry, observeNewestBar } from '../../observability/health.registry.js';
import { HEALTH_PATHS } from '../lib/health-paths.js';
import { resetMetrics } from '../lib/metrics.js';
import { registerHealthRoutes } from './health.js';

/**
 * A fixed "now" for the freshness assertions below.
 *
 * Not the wall clock: these tests are about whether the system knows how old its
 * data is, and a reading that depends on the hour the suite happens to run is a
 * reading that passes on Tuesday and fails on Sunday.
 */
const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

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
        // Deliberately without `count`. A readiness probe that had to name a
        // market would be unable to say anything about a second one, and the
        // absence of the method here is the assertion: if the route reaches for
        // it, the call is a TypeError and readiness reports 503.
        isReadable: vi.fn(),
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
    voteRepository.isReadable.mockResolvedValue(true);

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
}, 30_000);

describe('readiness', () => {
    it('asks whether the vote store is readable without naming a market', async () => {
        // The point of the change this asserts. Readiness is a question about
        // the database, and a question that has no market in it should not have
        // to name one to be asked.
        await track(createApp()).inject({ method: 'GET', url: '/readyz' });

        expect(voteRepository.isReadable).toHaveBeenCalled();
        expect(
            (voteRepository as unknown as Record<string, unknown>).count,
        ).toBeUndefined();
    });

    it('is ready when the database answers', async () => {
        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            status: 'ready',
            checks: {
                database: { ok: true },
                // Reported, not gating. The venue list is a pure read of state
                // this process already keeps, so the probe costs nothing and
                // cannot be the thing that provokes the rate limit it is
                // checking for.
                marketData: expect.objectContaining({
                    ok: expect.any(Boolean),
                    venues: expect.any(Array),
                }),
                // The registry's own view, reported here and not folded into
                // the readiness decision. Asserted with a shape rather than
                // swallowed: an operator reading this endpoint has to be able
                // to learn how old the data they are being shown is, and that
                // question had no answer anywhere they could reach.
                components: expect.objectContaining({
                    state: expect.any(String),
                    components: expect.any(Array),
                    problems: expect.any(Array),
                }),
            },
        });
    });

    it('says a stale market degrades the report without failing readiness', async () => {
        // Three days on a daily bar. A weekend is not an outage, and a probe
        // that failed on it would pull a working instance out of rotation.
        //
        // The component is named rather than the report's aggregate, because the
        // aggregate is the worst component present and one of them reads the
        // newest bar timestamp out of the database against the wall clock — so
        // asserting on the aggregate here would be asserting on whatever the
        // test database happens to hold, which is exactly the flake this suite
        // does not need.
        observeNewestBar('BTCUSDT', NOW - 3 * DAY);

        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        const component = response
            .json()
            .checks.components.components.find(
                (entry: { name: string }) => entry.name === 'market-freshness',
            );

        expect(component.state).toBe('degraded');
        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('ready');
    });

    it('keeps a dead feed from turning into a dead process', async () => {
        // Forty days is not "a bit old", it is nothing arriving at all, and the
        // registry is right to call it failing. Readiness is still 200, because
        // the instance can serve the data it already has and restarting it
        // would not make the exchange send bars.
        observeNewestBar('BTCUSDT', NOW - 40 * DAY);

        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('ready');
        expect(response.json().checks.components.state).toBe('failing');
    });

    it('stops claiming the snapshot is direct once it is not', async () => {
        // **This is the lie the registry used to tell.** It answered
        // `ageMs: () => 0` and `stale: false`, so `market-freshness` said
        // «снимок получен напрямую» at every instant of the process's life,
        // including the instants it served week-old candles — and did so
        // without a database call, which is the cheapest possible way to be
        // confidently wrong.
        // A registry of our own with a **frozen clock**, because the age is now
        // read at report time rather than frozen at write time. That change is
        // the point of the item, and this assertion used to depend on the old
        // behaviour: with the age computed where it is stored, `observeNewestBar
        // (…, NOW)` produced an age of zero by construction and the assertion
        // below was true for the wrong reason.
        //
        // The observation map is module state, so a registry built here sees the
        // same bars the singleton does — only its clock differs.
        const registry = createHealthRegistry({
            database: { async ping() {/* healthy */} },
            // Only the database check and the clock. The probes are the
            // registry's own, which is the point: a stubbed probe would have made
            // this test assert that the stub works, and this test is about what the
            // registry says.
            now: () => NOW,
            freshWithinMs: 2 * DAY,
            candleIntervalMs: DAY,
        });

        observeNewestBar('BTCUSDT', NOW - 40 * DAY);

        const report = await registry.report();
        const freshness = report.components.find(
            (component) => component.name === 'market-freshness',
        );

        expect(freshness?.state).toBe('degraded');
        expect(freshness?.dataAgeMs).toBe(40 * DAY);

        observeNewestBar('BTCUSDT', NOW);

        const fresh = await registry.report();

        expect(
            fresh.components.find((c) => c.name === 'market-freshness')?.state,
        ).toBe('ok');
    });

    it('grows the reported age between two reports without a new observation', async () => {
        // The half of the fix with nothing to do with markets: the age used to be
        // computed when the bar was observed and returned verbatim, so a snapshot
        // that went stale at 03:00 and was asked about at 05:00 reported its age
        // as of 03:00 — and before the first observation it reported `0`, which
        // reads as «снимок получен напрямую».
        //
        // Asserted through the registry rather than through the helper, because
        // the helper is module-private and the claim is about what a report says.
        // Two reports, one observation, and a clock that moved: the second has to
        // be a minute older than the first, or the number is frozen at write time
        // again.
        let clock = 1_000_000;

        const registry = createHealthRegistry({
            database: { async ping() {/* healthy */} },
            now: () => clock,
            freshWithinMs: 2 * DAY,
            candleIntervalMs: DAY,
        });

        observeNewestBar('BTCUSDT', 1_000_000);

        const first = await registry.report();
        const firstAge = first.components.find(
            (component) => component.name === 'market-freshness',
        )?.dataAgeMs;

        clock = 1_060_000;

        const second = await registry.report();
        const secondAge = second.components.find(
            (component) => component.name === 'market-freshness',
        )?.dataAgeMs;

        expect(firstAge).toBe(0);
        expect(secondAge).toBe(60_000);
    });

    it('reports market-data venues without making readiness flap', async () => {
        const healthy = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        expect(healthy.statusCode).toBe(200);
        expect(healthy.json().checks.marketData.venues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    provider: expect.any(String),
                    state: expect.any(String),
                    circuit: expect.any(String),
                    available: expect.any(Boolean),
                }),
            ]),
        );

        // A dead upstream is exactly the state the service already handles — it
        // serves the last good snapshot and says so in a header. Failing
        // readiness on it would pull a working instance out of rotation for a
        // blip, so it is reported and deliberately not acted on.
        expect(healthy.json().checks.marketData.ok).toBeTypeOf('boolean');
    });

    it('reports a reason to the caller and keeps the detail in the log', async () => {
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
        expect(response.json().checks.database.reason).toBe('database_unusable');

        // The message is what tells a wrong password from a wrong host, and the
        // server still writes it — but the endpoint is unauthenticated and
        // exempt from the rate limiter, so the message goes to the log and not
        // to whoever asked. It names the user and the host it could not reach.
        expect(response.json().checks.database.reason).not.toContain('password');
        expect(response.body).not.toContain('buynotbuy');
        expect(response.body).not.toContain('password authentication failed');
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
        // wrongly, which is not something a probe can recover from. The
        // versions are the caller's to know — the schema name is not.
        expect(response.statusCode).toBe(503);
        expect(response.json().checks.database.reason).toBe('schema_too_new');
        expect(response.body).not.toContain(`v${LATEST_SCHEMA_VERSION + 1}`);
    });

    it('reports an unreadable vote table as not ready', async () => {
        voteRepository.isReadable.mockRejectedValue(
            new Error('relation "indicator_vote" does not exist'),
        );

        const response = await track(createApp()).inject({
            method: 'GET',
            url: '/readyz',
        });

        // The vote store is a second table in the same database, and the
        // readiness check reads it for exactly this reason: otherwise a
        // missing table surfaces as a silent no-op on the first write. The
        // table's name stays out of the answer, the same as its host and user.
        expect(response.statusCode).toBe(503);
        expect(response.json().checks.database.ok).toBe(false);
        expect(response.json().checks.database.reason).toBe('database_unusable');
        expect(response.body).not.toContain('indicator_vote');
    });
}, 30_000);

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
}, 30_000);

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

    /**
     * The list and the routes it describes, held to each other.
     *
     * The exemption above is written out as three literals, so it keeps passing
     * when a fourth probe is added and the fourth probe is rate-limited — which
     * is the failure the list exists to prevent, arriving through the
     * documented way of extending it. This asserts the two sets are the same
     * set, so the failure is a failing test rather than a probe that answers
     * 429 until the orchestrator gives up on the instance.
     *
     * The routes are read from a bare instance rather than from the
     * application, because what matters is what `registerHealthRoutes`
     * *declares* — not what survived the rest of the wiring.
     */
    it('exempts exactly the health routes it registers', async () => {
        const declared: string[] = [];
        const bare = Fastify();

        bare.addHook('onRoute', (route) => {
            declared.push(route.url);
        });

        registerHealthRoutes(bare);
        await bare.ready();

        // `onRoute` fires once per method and Fastify adds HEAD beside every
        // GET, so the set is taken rather than the list.
        expect([...new Set(declared)].sort()).toEqual([...HEALTH_PATHS].sort());
    });
}, 30_000);
