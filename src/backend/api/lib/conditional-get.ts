import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Conditional GET for the endpoints whose answer changes on its own.
 *
 * The analysis is recomputed per request and the market snapshot is polled
 * every minute, so a page that reloads on a timer asks for an answer that
 * usually did not change and pays for the full candle series every time. A
 * 304 answers that in a few bytes.
 */
export interface ETagOptions {
    /**
     * Top-level fields that change on every read and say nothing about the
     * market.
     *
     * The analysis stamps `Date.now()` into its own timestamp, so hashing the
     * whole body produces a fresh tag per request and the client never gets a
     * single 304 — a header that costs a hash and delivers nothing. These
     * fields are left out of the comparison so the tag tracks the answer
     * rather than the moment it was asked for.
     */
    volatileFields?: readonly string[];
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];

    if (Array.isArray(value)) {
        return value[0];
    }

    return value;
}

/**
 * Builds the tag for a payload.
 *
 * When anything was excluded the result is a **weak** validator, `W/"..."`,
 * and that is the specification being used correctly rather than a
 * simplification: the bytes on the wire differ (the timestamp moved) while the
 * meaning does not. Claiming a strong tag over a body that is not byte-for-byte
 * identical would be a false promise, and a cache that believed it would hand
 * the client the old timestamp permanently.
 */
export function computeEtag(payload: unknown, options: ETagOptions = {}): string {
    const volatileFields = options.volatileFields ?? [];

    const comparable =
        volatileFields.length === 0 || typeof payload !== 'object' || payload === null
            ? payload
            : Object.fromEntries(
                  Object.entries(payload as Record<string, unknown>).filter(
                      ([key]) => !volatileFields.includes(key),
                  ),
              );

    const digest = createHash('sha256')
        .update(JSON.stringify(comparable))
        .digest('base64url');

    return volatileFields.length === 0 ? `"${digest}"` : `W/"${digest}"`;
}

/**
 * Splits an `If-None-Match` header into comparable tags.
 *
 * `*` matches anything, which is what the specification says it means, and the
 * weakness qualifier is stripped on both sides so `W/"x"` compares equal to
 * `"x"`: it describes the transfer, not the value.
 */
export function ifNoneMatchSatisfied(
    ifNoneMatch: string | undefined,
    etag: string,
): boolean {
    if (ifNoneMatch === undefined) {
        return false;
    }

    const trimmed = ifNoneMatch.trim();

    if (trimmed === '*') {
        return true;
    }

    const normalized = etag.replace(/^W\//, '');

    return trimmed.split(',').some((candidate) => {
        const value = candidate.trim().replace(/^W\//, '');

        return value.length > 0 && value === normalized;
    });
}

export function sendWithEtag(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    options: ETagOptions = {},
): FastifyReply {
    const etag = computeEtag(payload, options);

    reply.header('ETag', etag);

    // No Cache-Control here on purpose. Caching is the freshness layer's
    // decision, because it is the layer that knows the answer may be a
    // repeated snapshot; two places that both set the policy is how a stale
    // response quietly becomes cacheable again.

    if (ifNoneMatchSatisfied(headerValue(request, 'if-none-match'), etag)) {
        return reply.status(304).send();
    }

    return reply.send(payload);
}
