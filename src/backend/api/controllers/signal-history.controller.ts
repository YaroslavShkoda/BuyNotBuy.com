import { z } from 'zod';

import type { FastifyBaseLogger } from 'fastify';

import { getSignalHistory as readSignalHistory, summarizeHistory } from '../../history/signal-history.service.js';
import { historyConfig } from '../../config/history.config.js';
import { ApplicationError } from '../../errors/application.error.js';
import { SignalHistoryResponseSchema } from '../schemas.js';
import { bucketOf, decodeCursor, encodeCursor } from '../lib/history-cursor.js';

const SignalHistoryQuerySchema = z.object({
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(historyConfig.maxLimit)
        .default(historyConfig.defaultLimit),
    cursor: z.string().min(1).optional(),
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

    const { limit, cursor } = parsedQuery.data;

    let before: number | undefined;

    if (cursor !== undefined) {
        const decoded = decodeCursor(cursor);

        if (decoded === null) {
            // Treated as a bad request rather than ignored: a client that
            // silently gets the newest page back after sending a stale cursor
            // will render page one twice and call it a duplicate history.
            logger?.warn(
                { event: 'signal_history_cursor_invalid' },
                'signal_history_cursor_invalid',
            );

            throw new ApplicationError('Invalid signal history cursor', {
                code: 'INVALID_REQUEST',
                statusCode: 400,
            });
        }

        before = decoded;
    }

    // The summary describes the whole record, not the page. Deriving it from
    // the current page would make "how long has this signal held" a function
    // of how many entries the client happened to ask for, so walking back
    // through the history would appear to shorten the run.
    const fullHistory = await readSignalHistory(historyConfig.maxEntries);

    // One extra row answers "is there a next page?" without a second query.
    // Without it the last full page would advertise a cursor that leads to an
    // empty result, which is indistinguishable from reaching the end.
    const entries =
        before === undefined
            ? fullHistory.slice(0, limit + 1)
            : await readSignalHistory(limit + 1, before);
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const last = page.at(-1);

    return SignalHistoryResponseSchema.parse({
        entries: page,
        summary: summarizeHistory(fullHistory),
        nextCursor:
            hasMore && last !== undefined ? encodeCursor(bucketOf(last.timestamp)) : null,
    });
}
