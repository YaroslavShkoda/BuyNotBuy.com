import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApplicationError } from '../errors/application.error';
import { marketConfig } from '../config/market.config';
import { readAnalysisErrorContext } from '../services/analysis.telemetry';

import type { ErrorCode } from '../errors/application.error';
import type { ApiErrorResponse } from './error-handler.types';

const PUBLIC_MESSAGES: Record<ErrorCode, string> = {
    MARKET_DATA_UNAVAILABLE: 'Market data is temporarily unavailable',
    MARKET_PROVIDER_ERROR: 'Market data provider unavailable',
    MARKET_PROVIDER_TIMEOUT: 'Market data provider timed out',
    VALIDATION_ERROR: 'Invalid market data response',
    INVALID_REQUEST: 'Invalid request parameters',
    INTERNAL_ERROR: 'Internal server error',
};

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

        return reply.status(statusCode).send(body);
    });
}
