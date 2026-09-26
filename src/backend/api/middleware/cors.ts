import type { FastifyReply, FastifyRequest } from 'fastify';

import { appConfig } from '../../config/app.config.js';

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type';

function resolveOrigin(
    origin: string | undefined,
    allowedOrigins: readonly string[],
): string | null {
    if (origin === undefined) {
        return null;
    }

    return allowedOrigins.includes(origin) ? origin : null;
}

/**
 * Cross-origin access, off unless an origin is explicitly configured.
 *
 * The dashboard reads this API from the server, not the browser, so nothing
 * needs cross-origin access today and the default list is empty. That matters:
 * a wildcard would let any page a user visits read their market view, and the
 * list is matched exactly rather than by suffix, so `https://evil-example.com`
 * cannot pass as `example.com`.
 *
 * `Vary: Origin` is set on every response, including refusals, so a shared
 * cache cannot serve one origin's decision to another.
 */
export function applyCorsHeadersFor(
    request: FastifyRequest,
    reply: FastifyReply,
    allowedOrigins: readonly string[],
): void {
    const origin = request.headers.origin;

    reply.header('Vary', 'Origin');

    if (origin === undefined) {
        return;
    }

    const allowed = resolveOrigin(origin, allowedOrigins);

    if (allowed === null) {
        // No allow-list entry means no CORS headers at all. The browser then
        // blocks the read, which is the intended outcome.
        return;
    }

    reply.header('Access-Control-Allow-Origin', allowed);
    reply.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
    reply.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    reply.header('Access-Control-Max-Age', '600');
}

export function applyCorsHeaders(
    request: FastifyRequest,
    reply: FastifyReply,
): void {
    applyCorsHeadersFor(request, reply, appConfig.corsOrigins);
}

export function registerPreflight(
    reply: FastifyReply,
    request: FastifyRequest,
): void {
    applyCorsHeaders(request, reply);

    reply.status(204).send();
}
