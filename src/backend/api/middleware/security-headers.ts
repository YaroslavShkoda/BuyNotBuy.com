import type { FastifyReply } from 'fastify';

import { appConfig } from '../../config/app.config.js';

/**
 * Headers applied to every response.
 *
 * The service only ever returns JSON, so the policy set is the strictest one
 * that still leaves that working: nothing may be loaded, framed, embedded or
 * sniffed out of a response. Each header closes a specific way a browser can
 * be talked into treating an API response as something it is not.
 */
export function applySecurityHeaders(reply: FastifyReply): void {
    // Stop the browser from guessing a content type and executing a body that
    // arrived as JSON but is read as HTML.
    reply.header('X-Content-Type-Options', 'nosniff');

    // This API has no business in an iframe; framing it enables
    // clickjacking against the dashboard that consumes it.
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');

    // Nothing here benefits from leaking the API URL to a third party.
    reply.header('Referrer-Policy', 'no-referrer');

    // No script, no styles, no connections, no framing — the response body is
    // data and must never be treated as a document.
    reply.header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );

    // This service needs no device capabilities at all.
    reply.header(
        'Permissions-Policy',
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    );

    if (appConfig.hstsMaxAgeSeconds > 0) {
        // Only meaningful once TLS is in front; sending it over plain HTTP is
        // ignored by browsers, so it is off by default for local development.
        reply.header(
            'Strict-Transport-Security',
            `max-age=${appConfig.hstsMaxAgeSeconds}; includeSubDomains`,
        );
    }
}
