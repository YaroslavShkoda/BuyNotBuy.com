import { z } from 'zod';
import { CandleIntervalSchema } from '../../config/market.config.js';
import { ApplicationError } from '../../errors/application.error.js';
import type { CandleInterval } from '../../types/candle-interval.js';

const IntervalQuerySchema = z.object({
    interval: CandleIntervalSchema.optional(),
});

/**
 * The `?interval=` of a request, or the absence of one.
 *
 * Strict on the values and absent-by-default on the parameter: a request that
 * names nothing means "the configured interval" everywhere downstream, and a
 * request that names a value the system cannot compute is a refusal rather
 * than a silent redirect to the default — a client that typed `1W` and got 1h
 * would be reading the wrong series under the right URL.
 */
export function intervalQuery(query: unknown): CandleInterval | undefined {
    const parsed = IntervalQuerySchema.safeParse(query ?? {});

    if (!parsed.success) {
        throw new ApplicationError(
            'Invalid interval: expected one of 15m, 1h, 4h, 1d',
            {
                code: 'INVALID_REQUEST',
                statusCode: 400,
            },
        );
    }

    return parsed.data.interval;
}
