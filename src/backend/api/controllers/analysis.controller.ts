import type { FastifyBaseLogger } from 'fastify';

import { analyzeMarketWithStatus } from '../../services/analysis.service.js';
import { MarketAnalysisSchema } from '../schemas.js';

export interface ControllerResult<T> {
    payload: T;
    /** The market snapshot was reused after a provider failure. */
    stale: boolean;
    ageMs: number;
}

export async function getAnalysis(
    logger?: FastifyBaseLogger,
    requestId?: string,
): Promise<ControllerResult<ReturnType<typeof MarketAnalysisSchema.parse>>> {
    const adapter = logger === undefined
        ? undefined
        : {
            info: (
                context: Parameters<FastifyBaseLogger['info']>[0],
                message: string,
            ): void => {
                logger.info(context, message);
            },
        };

    const { analysis, stale, ageMs } = await analyzeMarketWithStatus(
        adapter,
        requestId,
        logger,
    );

    return {
        payload: MarketAnalysisSchema.parse(analysis),
        stale,
        ageMs,
    };
}
