import type { FastifyInstance, FastifyRequest } from 'fastify';

import { getIndicatorVoteRepository } from '../../indicators/performance/indicator-vote.repository.js';
import { getSignalHistoryRepository } from '../../history/signal-history.repository.js';
import { LATEST_SCHEMA_VERSION } from '../../db/migrations.js';
import { renderMetrics } from '../lib/metrics.js';
import { readRequestId } from '../lib/redaction.js';
import { observabilityConfig } from '../../config/observability.config.js';
import { configuredMarketVenues } from '../../market/market.provider.js';
import { venueHealth } from '../../market/providers/provider-http.js';
import { healthRegistry } from '../../observability/health.registry.js';

/** Schema version this build can read. Anything higher is not ours to serve. */
const SUPPORTED_SCHEMA_VERSION = LATEST_SCHEMA_VERSION;

/**
 * Stable reasons a check can fail, safe to hand to any caller.
 *
 * The reason and the detail are deliberately two different things. A PostgreSQL
 * message carries the user name, the host and the port it failed to reach, and
 * `/readyz` needs no credential to reach — it is unauthenticated and exempt from
 * the rate limiter. An operator gets the full message from the log, correlated
 * by the request id that is already echoed in the response header; a caller gets
 * a code it can branch on and nothing to learn about the network from.
 */
const READINESS_REASON = {
    schemaTooNew: 'schema_too_new',
    databaseUnusable: 'database_unusable',
} as const;

interface CheckResult {
    ok: boolean;
    /** Stable code. Safe to return to the caller. */
    reason?: (typeof READINESS_REASON)[keyof typeof READINESS_REASON];
    /** Operator-only. Written to the log, never to a response body. */
    detail?: string;
}

/**
 * Touches the database without pretending to know more than it does.
 *
 * `schemaVersion` asks the server and returns. That is enough to fail when the
 * database is unreachable, when the credentials are wrong, and when it was
 * written by a newer build — the three states that actually stop this service
 * from working.
 */
async function databaseIsUsable(): Promise<CheckResult> {
    try {
        const version = await getSignalHistoryRepository().schemaVersion();

        if (version > SUPPORTED_SCHEMA_VERSION) {
            return {
                ok: false,
                reason: READINESS_REASON.schemaTooNew,
                detail:
                    `database schema v${version} is newer than this build understands ` +
                    `(v${SUPPORTED_SCHEMA_VERSION})`,
            };
        }

        // The vote store is a second table in the same database. Reading it
        // here means a missing table is reported now, rather than as a silent
        // no-op on the first write an hour from now.
        //
        // As a reachability question rather than a count. It used to ask for
        // `count('BTCUSDT')`, which put a market name into a probe whose whole
        // subject is "is the database usable" — and a readiness check that
        // hardcodes a market cannot be run against a second one.
        await getIndicatorVoteRepository().isReadable();

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason: READINESS_REASON.databaseUnusable,
            detail: error instanceof Error ? error.message : 'unknown database failure',
        };
    }
}

function withRequestId(
    reply: { header(name: string, value: string): unknown },
    request: FastifyRequest,
): void {
    const requestId = readRequestId(request);

    if (requestId !== undefined) {
        reply.header(observabilityConfig.requestIdHeader, requestId);
    }
}

/**
 * Whether a live price is obtainable, and from where.
 *
 * A no-op on the network on purpose: it reads the breakers and the health
 * records this process already keeps, so the probe costs nothing and cannot be
 * the thing that provokes the rate limit it is checking for.
 */
function marketDataReport(): {
    ok: boolean;
    detail?: string;
    venues: Array<{
        provider: string;
        state: string;
        circuit: string;
        available: boolean;
    }>;
} {
    const venues = configuredMarketVenues().map((provider) => {
        const health = venueHealth(provider);

        return {
            provider,
            state: health.state,
            circuit: health.circuit,
            available: health.available,
        };
    });

    return {
        ok: venues.some((venue) => venue.available),
        ...(venues.every((venue) => !venue.available)
            ? { detail: 'no configured market data venue is currently available' }
            : {}),
        venues,
    };
}

export function registerHealthRoutes(app: FastifyInstance): void {
    /**
     * Liveness: is the process running?
     *
     * Deliberately checks nothing else. A liveness probe that also asks the
     * database restarts the process when the database is down, turning a
     * dependency's outage into a crash loop and destroying the evidence in the
     * process.
     */
    app.get('/healthz', async (request, reply) => {
        withRequestId(reply, request);

        return reply.status(200).send({ status: 'ok' });
    });

    /**
     * Readiness: should this instance receive traffic?
     *
     * The upstream provider is reported but not gating, on purpose. Its state
     * changes every few seconds, and a probe that failed on a blip would pull a
     * working instance out of rotation for something the service already handles
     * — it serves the last good snapshot and says so in a header. Only state the
     * process cannot recover from belongs in the decision.
     *
     * Reported anyway, because the opposite failure is just as bad: an instance
     * serving nothing but expired cache for an hour looks identical to a healthy
     * one from the outside, and this is the one place a load balancer operator is
     * guaranteed to look.
     */
    app.get('/readyz', async (request, reply) => {
        withRequestId(reply, request);

        const database = await databaseIsUsable();
        const marketData = marketDataReport();

        // The registry's own view, reported alongside rather than merged into
        // the readiness decision.
        //
        // **Not gating is the point, not an oversight.** A stale daily bar is
        // normal at the weekend, and a probe that failed on it would pull a
        // working instance out of rotation for something the service already
        // handles. What it would also do is convert "the data is a bit old" into
        // "the process is down", and the two call for completely different
        // responses from whoever is on call.
        //
        // It is reported here because this is the one endpoint a load balancer
        // operator is guaranteed to look at, and because until now nothing they
        // could reach could tell them how old the data they are being shown is.
        const components = await healthRegistry.report();

        if (components.problems.length > 0) {
            request.log.warn(
                { event: 'components_degraded', problems: components.problems },
                'components_degraded',
            );
        }

        if (!database.ok) {
            request.log.warn(
                { event: 'readiness_failed', detail: database.detail },
                'readiness_failed',
            );

            return reply.status(503).send({
                status: 'not_ready',
                // The reason, never the detail: the detail names the user and
                // the host it could not reach, and this endpoint is open.
                // `requestId` above correlates the two — the operator reads the
                // message out of the log, the caller reads the code.
                checks: {
                    database: { ok: false, reason: database.reason },
                    marketData,
                    components,
                },
            });
        }

        if (!marketData.ok) {
            request.log.warn(
                { event: 'market_data_degraded', detail: marketData.detail },
                'market_data_degraded',
            );
        }

        return reply.status(200).send({
            status: 'ready',
            checks: {
                database: { ok: true },
                marketData,
                components,
            },
        });
    });

    app.get('/metrics', async (request, reply) => {
        withRequestId(reply, request);

        reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');

        return reply.status(200).send(renderMetrics());
    });
}
