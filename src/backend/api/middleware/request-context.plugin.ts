import type { FastifyInstance } from 'fastify';

import { observabilityConfig } from '../../config/observability.config.js';

import { readRequestId } from '../lib/redaction.js';
import { recordRequestFinished, recordRequestStarted } from '../lib/metrics.js';

/**
 * Correlation ids and request counting.
 *
 * A client-supplied id is adopted when it is safe to log, so one identifier
 * follows a request from the caller through the upstream provider and back in
 * the answer. When the client sends nothing usable, Fastify's own generated id
 * is used — an absent id would be worse, because nothing could be correlated at
 * all.
 *
 * Counting starts in `onRequest` rather than at the handler, so a request that
 * is still queued behind the rate limiter is already visible, and it ends in
 * `onResponse`, which Fastify runs even when a handler threw.
 */
export function registerRequestContext(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
        const supplied = readRequestId(request);

        if (supplied !== undefined) {
            // Echoed so a caller can find their own request in the log. The
            // generated id stays in `reqId`, which is what the error handler
            // already reports, so the two never have to be reconciled.
            request.id = supplied;
            reply.header(observabilityConfig.requestIdHeader, supplied);
        }

        recordRequestStarted(request);
    });

    app.addHook('onResponse', async (request, reply) => {
        recordRequestFinished(request, reply);
    });
}
