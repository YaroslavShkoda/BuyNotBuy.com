import type { FastifyInstance, FastifyRequest } from 'fastify';

import { getIndicatorVoteRepository } from '../../indicators/performance/indicator-vote.repository.js';
import { getSignalHistoryRepository } from '../../history/signal-history.repository.js';
import { LATEST_SCHEMA_VERSION } from '../../db/migrations.js';
import { renderMetrics } from '../lib/metrics.js';
import { readRequestId } from '../lib/redaction.js';
import { observabilityConfig } from '../../config/observability.config.js';

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
        await getIndicatorVoteRepository().count('BTCUSDT');

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
     * The upstream provider is not checked, on purpose. Its state changes every
     * few seconds, and a probe that failed on a blip would pull a working
     * instance out of rotation for something the service already handles — it
     * serves the last good snapshot and says so in a header. Only state the
     * process cannot recover from belongs here.
     */
    app.get('/readyz', async (request, reply) => {
        withRequestId(reply, request);

        const database = await databaseIsUsable();

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
                checks: { database: { ok: false, reason: database.reason } },
            });
        }

        return reply.status(200).send({
            status: 'ready',
            checks: { database: { ok: true } },
        });
    });

    app.get('/metrics', async (request, reply) => {
        withRequestId(reply, request);

        reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');

        return reply.status(200).send(renderMetrics());
    });
}

/**
 * Routes that must stay answerable while everything else is failing.
 *
 * A load balancer polling a rate-limited `/healthz` would take every instance
 * out of rotation at once — the probe traffic alone would be what broke it.
 */
export const HEALTH_PATHS = ['/healthz', '/readyz', '/metrics'] as const;
