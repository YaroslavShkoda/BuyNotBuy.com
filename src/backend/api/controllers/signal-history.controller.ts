import { z } from 'zod';

import type { FastifyBaseLogger } from 'fastify';

import { getSignalHistory as readSignalHistory, summarizeHistory } from '../../history/signal-history.service';
import { historyConfig } from '../../config/history.config';
import { ApplicationError } from '../../errors/application.error';
import { SignalHistoryResponseSchema } from '../schemas';

const SignalHistoryQuerySchema = z.object({
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(historyConfig.maxLimit)
        .default(historyConfig.defaultLimit),
});

export async function getSignalHistory(
    query: unknown,
    logger?: FastifyBaseLogger,
) {
    const parsedQuery = SignalHistoryQuerySchema.safeParse(query ?? {});

    if (!parsedQuery.success) {
        logger?.warn(
            { event: 'signal_history_request_invalid' },
            'signal_history_request_invalid',
        );

        throw new ApplicationError('Invalid signal history query', {
            code: 'INVALID_REQUEST',
            statusCode: 400,
        });
    }

    const entries = readSignalHistory(parsedQuery.data.limit);

    return SignalHistoryResponseSchema.parse({
        entries,
        summary: summarizeHistory(entries),
    });
}
