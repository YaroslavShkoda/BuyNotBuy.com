import { observabilityConfig } from '../../config/observability.config.js';

import type { FastifyRequest } from 'fastify';

/**
 * Key names whose values are replaced before anything is written to a log.
 *
 * A regex cannot be trusted to catch every secret — a connection string, a
 * header with a custom name, a token in a query string — so this is a backstop
 * for the shapes that are known to appear, not a guarantee. The real
 * protection is not logging the values in the first place.
 */
const REDACTED = '[redacted]';

export function redactText(text: string): string {
    // Bearer is substituted first on purpose. The key/value rule below would
    // otherwise match `Authorization: Bearer` and stop there, replacing the
    // word "Bearer" and leaving the token itself fully readable in the log.
    return text
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
        // `key=value` / `key: value` where the key says it is a secret.
        .replace(
            /\b(api[_-]?key|apikey|secret|token|password|passwd|authorization|cookie|set-cookie|private[_-]?key|connection[_-]?string|dsn)(\s*[:=]\s*)"?[^\s"',;}]+"?/gi,
            (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
        )
        // Credentials inside a URL: scheme://user:password@host
        .replace(
            /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
            (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
        );
}

/**
 * Replaces secret-looking values anywhere in a log line or context object.
 *
 * The original objects are not modified: they are often the very error being
 * reported, and rewriting them in place would make the thrown error disagree
 * with what was written down.
 */
export function redactValue(value: unknown, depth = 0): unknown {
    // Deep structures are walked shallowly on purpose: an unexpected object
    // three levels down must not be able to turn one log call into a walk of a
    // whole provider response.
    if (depth > 4) {
        return REDACTED;
    }

    if (typeof value === 'string') {
        return redactText(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, depth + 1));
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactText(value.message),
            stack: value.stack === undefined ? undefined : redactText(value.stack),
        };
    }

    if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {};

        for (const [key, nested] of Object.entries(value)) {
            result[key] = redactValue(nested, depth + 1);
        }

        return result;
    }

    return value;
}

const REQUEST_ID_PATTERN = /^[\x21-\x7E]+$/;

/**
 * Accepts a client-supplied request id only if it is safe to log.
 *
 * A rejected id is replaced rather than refused: the request is perfectly
 * valid, and refusing it would let anyone who can set a header decide whether
 * the API works.
 */
export function sanitizeRequestId(raw: unknown): string | undefined {
    if (typeof raw !== 'string') {
        return undefined;
    }

    const trimmed = raw.trim();

    if (
        trimmed === '' ||
        trimmed.length > observabilityConfig.requestIdMaxLength ||
        !REQUEST_ID_PATTERN.test(trimmed)
    ) {
        return undefined;
    }

    return trimmed;
}

export function readRequestId(request: FastifyRequest): string | undefined {
    const value = request.headers[observabilityConfig.requestIdHeader];

    return sanitizeRequestId(Array.isArray(value) ? value[0] : value);
}
