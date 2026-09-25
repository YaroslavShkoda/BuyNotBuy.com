import type { FastifyBaseLogger } from 'fastify';

import { analyzeMarket } from '../../services/analysis.service';
import { MarketAnalysisSchema } from '../schemas';

export async function getAnalysis(
    logger?: FastifyBaseLogger,
    requestId?: string,
) {
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

    const analysis = await analyzeMarket(
        adapter,
        requestId,
        logger,
    );

    return MarketAnalysisSchema.parse(analysis);
}
