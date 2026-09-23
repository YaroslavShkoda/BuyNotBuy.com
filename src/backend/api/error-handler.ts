import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApplicationError } from '../errors/application.error';

import type { ErrorCode } from '../errors/application.error';

export const ApiErrorResponseSchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
    }),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

const PUBLIC_MESSAGES: Record<ErrorCode, string> = {
    MARKET_DATA_UNAVAILABLE: 'Market data is temporarily unavailable',
    MARKET_PROVIDER_ERROR: 'Market data provider unavailable',
    MARKET_PROVIDER_TIMEOUT: 'Market data provider timed out',
    VALIDATION_ERROR: 'Invalid market data response',
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
        request.log.error(error);

        const { statusCode, body } = toPublicError(error);

        return reply.status(statusCode).send(body);
    });
}
