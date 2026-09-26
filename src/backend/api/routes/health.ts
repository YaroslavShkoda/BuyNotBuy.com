import type { FastifyInstance, FastifyRequest } from 'fastify';

import { getIndicatorVoteRepository } from '../../indicators/performance/indicator-vote.repository.js';
import { getSignalHistoryRepository } from '../../history/signal-history.repository.js';
import { renderMetrics } from '../lib/metrics.js';
import { readRequestId } from '../lib/redaction.js';
import { observabilityConfig } from '../../config/observability.config.js';

/** Schema version this build can read. Anything higher is not ours to serve. */
const SUPPORTED_SCHEMA_VERSION = 1;

interface CheckResult {
    ok: boolean;
    detail?: string;
}

/**
 * Touches the database without pretending to know more than it does.
 *
 * `schemaVersion` opens the file, reads `user_version` and returns. That is
 * enough to fail when the path is unwritable, when the file is not a database,
 * and when it was written by a newer build — the three states that actually
 * stop this service from working.
 */
function databaseIsUsable(): CheckResult {
    try {
        const version = getSignalHistoryRepository().schemaVersion();

        if (version > SUPPORTED_SCHEMA_VERSION) {
            return {
                ok: false,
                detail:
                    `database schema v${version} is newer than this build understands ` +
                    `(v${SUPPORTED_SCHEMA_VERSION})`,
            };
        }

        // The vote store is a second connection to the same file. Opening it
        // here means a missing table is reported now, rather than as a silent
        // no-op on the first write an hour from now.
        getIndicatorVoteRepository().count('BTCUSDT');

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
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

        const database = databaseIsUsable();

        if (!database.ok) {
            request.log.warn(
                { event: 'readiness_failed', detail: database.detail },
                'readiness_failed',
            );

            return reply.status(503).send({
                status: 'not_ready',
                checks: { database: { ok: false, detail: database.detail } },
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
