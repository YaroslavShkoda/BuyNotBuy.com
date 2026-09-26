import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { appConfig } from '../../config/app.config.js';

import { FixedWindowRateLimiter, rateLimitError } from './rate-limit.js';

export const rateLimiter = new FixedWindowRateLimiter({
    max: appConfig.rateLimitMax,
    windowMs: appConfig.rateLimitWindowMs,
});

/**
 * Probe endpoints, which answer no matter what.
 *
 * A load balancer polling these on a short interval would spend the very
 * budget meant for real users, and would do it from one address — the probe —
 * so every instance could be taken out of rotation by traffic that exists only
 * to ask whether they are up.
 */
const EXEMPT_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Caps how much work a single client can queue.
 *
 * The dashboard recomputes indicators on every request, so an unbounded burst
 * is not just rude — it holds the event loop and delays everyone else's
 * answer. The limit is deliberately far above normal use; it exists to stop
 * abuse, not to ration the product.
 */
export function registerRateLimit(app: FastifyInstance): void {
    app.addHook('onRequest', async (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => {
        if (EXEMPT_PATHS.has(request.url.split('?')[0] ?? request.url)) {
            return;
        }

        const decision = rateLimiter.consume(request.ip);

        reply.header('X-RateLimit-Limit', String(appConfig.rateLimitMax));
        reply.header('X-RateLimit-Remaining', String(decision.remaining));
        reply.header(
            'X-RateLimit-Reset',
            String(Math.ceil(decision.resetAt / 1000)),
        );

        if (decision.allowed) {
            return;
        }

        throw rateLimitError(
            Math.ceil((decision.resetAt - Date.now()) / 1000),
        );
    });
}
