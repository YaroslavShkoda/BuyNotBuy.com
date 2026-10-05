import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { appConfig } from '../../config/app.config.js';
import { EXEMPT_PATHS } from '../lib/health-paths.js';
import { rateLimitError } from './rate-limit.js';
import { rateLimiter } from './rate-limit.repository.js';

/**
 * Probe endpoints, which answer no matter what.
 *
 * A load balancer polling these on a short interval would spend the very
 * budget meant for real users, and would do it from one address — the probe —
 * so every instance could be taken out of rotation by traffic that exists only
 * to ask whether they are up.
 *
 * **The list itself is not written here.** It used to be, as a private literal
 * beside this note while an exported copy stood unused in `routes/health.ts` —
 * two copies of the same three strings with nothing making them agree. It now
 * comes from `lib/health-paths.ts`, which both sides read and a test checks
 * against the routes actually registered.
 */

/**
 * Caps how much work a single client can queue.
 *
 * The dashboard recomputes indicators on every request, so an unbounded burst
 * is not just rude — it holds the event loop and delays everyone else's
 * answer. The limit is deliberately far above normal use; it exists to stop
 * abuse, not to ration the product.
 *
 * The hook is async now, and the one thing it refuses to do with a limiter
 * that cannot answer is answer on its behalf: a store that is down must not
 * become a site-wide 429, so the failure is logged and the request passes.
 * That is fail-open, and it is a decision, not an oversight — the counter is
 * anti-abuse, not a dependency the dashboard cannot live without, and an
 * outage in it must not multiply.
 */
export function registerRateLimit(app: FastifyInstance): void {
    app.addHook('onRequest', async (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => {
        if (EXEMPT_PATHS.has(request.url.split('?')[0] ?? request.url)) {
            return;
        }

        let decision;

        try {
            decision = await rateLimiter.consume(request.ip);
        } catch (error) {
            request.log.error(
                { event: 'rate_limit_store_failed', err: error },
                'rate_limit_store_failed',
            );

            return;
        }

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
