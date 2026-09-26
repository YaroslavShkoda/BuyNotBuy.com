import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { observabilityConfig } from '../../config/observability.config.js';

import { readRequestId, redactValue } from '../lib/redaction.js';
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

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

type Level = (typeof LEVELS)[number];

/**
 * Wraps the logger so nothing reaches a sink unredacted.
 *
 * Done here rather than at each call site on purpose: there are dozens of them,
 * and the one that forgets is the entire failure mode. The values most worth
 * hiding are exactly the ones an exception drags in, so filtering after the
 * exception is constructed is the only place that works.
 *
 * The original objects are copied, never modified — they are frequently the
 * very error being reported, and rewriting it in place would make the thrown
 * error disagree with what was written down.
 */
export function redactLogger(logger: FastifyBaseLogger): FastifyBaseLogger {
    const wrapped: Partial<Record<Level, unknown>> = {};

    for (const level of LEVELS) {
        wrapped[level] = (context: unknown, message?: unknown) => {
            const redactedMessage = redactValue(message);
            const redactedContext = redactValue(context);

            if (redactedContext === undefined) {
                return (logger[level] as (m?: unknown) => void)(redactedMessage);
            }

            return (logger[level] as (c: unknown, m?: unknown) => void)(
                redactedContext,
                redactedMessage,
            );
        };
    }

    const redacting = {
        ...logger,
        ...wrapped,
        child: (bindings?: Record<string, unknown>) =>
            redactLogger(logger.child(bindings ?? {})),
    };

    return redacting as unknown as FastifyBaseLogger;
}
