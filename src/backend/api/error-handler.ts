import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApplicationError } from '../errors/application.error.js';
import { marketConfig } from '../config/market.config.js';
import { readAnalysisErrorContext } from '../services/analysis.telemetry.js';

import type { ErrorCode } from '../errors/application.error.js';
import type { ApiErrorResponse } from './error-handler.types.js';

const PUBLIC_MESSAGES: Record<ErrorCode, string> = {
    MARKET_DATA_UNAVAILABLE: 'Market data is temporarily unavailable',
    MARKET_PROVIDER_ERROR: 'Market data provider unavailable',
    MARKET_PROVIDER_TIMEOUT: 'Market data provider timed out',
    MARKET_RATE_LIMITED: 'Market data provider rate limit reached',
    RATE_LIMITED: 'Too many requests',
    MARKET_INSUFFICIENT_HISTORY: 'Not enough market history for analysis',
    VALIDATION_ERROR: 'Invalid market data response',
    INVALID_REQUEST: 'Invalid request parameters',
    NOT_FOUND: 'Resource not found',
    INTERNAL_ERROR: 'Internal server error',
};

/**
 * Fastify's own request-level failures.
 *
 * These arrive with a correct 4xx status already attached, but they are not
 * `ApplicationError`, so without this table a malformed request body would be
 * reported as a 500 — telling the client the server is broken when the client
 * is the one that is, and poisoning every error dashboard with our bugs.
 *
 * Listed by code rather than by "any 4xx", because a 4xx coming from inside a
 * handler is frequently our own miscalculation wearing a borrowed status.
 */
const REQUEST_ERROR_STATUS: Record<string, number> = {
    FST_ERR_CTP_EMPTY_JSON_BODY: 400,
    FST_ERR_CTP_INVALID_MEDIA_TYPE: 415,
    FST_ERR_CTP_INVALID_JSON_BODY: 400,
    FST_ERR_CTP_BODY_TOO_LARGE: 413,
    FST_ERR_VALIDATION: 400,
    FST_ERR_BAD_URL: 400,
    FST_ERR_BAD_HOST: 400,
};

function requestErrorStatus(error: unknown): number | undefined {
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;

    return typeof code === 'string' ? REQUEST_ERROR_STATUS[code] : undefined;
}

export function toPublicError(error: unknown): { statusCode: number; body: ApiErrorResponse } {
    if (error instanceof ApplicationError) {
        return {
            statusCode: error.statusCode,
            body: {
                error: {
                    code: error.code,
                    message: PUBLIC_MESSAGES[error.code],
                },
            },
        };
    }

    const requestStatus = requestErrorStatus(error);

    if (requestStatus !== undefined) {
        return {
            statusCode: requestStatus,
            body: {
                error: {
                    code: 'INVALID_REQUEST',
                    message: PUBLIC_MESSAGES.INVALID_REQUEST,
                },
            },
        };
    }

    if (error instanceof z.ZodError) {
        return {
            statusCode: 500,
            body: {
                error: {
                    code: 'INTERNAL_ERROR',
                    message: PUBLIC_MESSAGES.INTERNAL_ERROR,
                },
            },
        };
    }

    return {
        statusCode: 500,
        body: {
            error: {
                code: 'INTERNAL_ERROR',
                message: PUBLIC_MESSAGES.INTERNAL_ERROR,
            },
        },
    };
}

export function registerErrorHandler(app: FastifyInstance): void {
    // A route that does not exist is the client's mistake, but it used to come
    // back in Fastify's own shape — `{"message":"Route ... not found"}` — with
    // no `code` field, so a client parsing every error the same way had to
    // special-case exactly one endpoint. Every error this service emits now
    // has the same envelope.
    app.setNotFoundHandler((request, reply) => {
        request.log.info(
            { event: 'request_not_found', url: request.url },
            'request_not_found',
        );

        return reply.status(404).send({
            error: {
                code: 'NOT_FOUND',
                message: PUBLIC_MESSAGES.NOT_FOUND,
            },
        });
    });

    app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
        const diagnostics = readAnalysisErrorContext(error);
        const code = error instanceof ApplicationError ? error.code : 'INTERNAL_ERROR';

        request.log.error({
            event: diagnostics === undefined
                ? 'request_failed'
                : 'market_analysis_failed',
            provider: marketConfig.provider,
            code,
            ...(diagnostics ?? {}),
            ...(diagnostics?.requestId === undefined ? { requestId: request.id } : {}),
            err: error,
        });

        const { statusCode, body } = toPublicError(error);

        // Telling the client when to come back is what keeps a rate-limited
        // client from becoming a second rate-limit offender.
        if (
            error instanceof ApplicationError &&
            error.retryAfterSeconds !== undefined
        ) {
            reply.header('Retry-After', String(error.retryAfterSeconds));
        }

        return reply.status(statusCode).send(body);
    });
}
