import type { FastifyBaseLogger } from 'fastify';
import type { MarketFreshness } from '../../market/market-freshness.js';
import { analyzeMarketWithStatus } from '../../services/analysis.service.js';
import { MarketAnalysisSchema } from '../schemas.js';

export interface ControllerResult<T> {
    payload: T;
    /** The market snapshot was reused after a provider failure. */
    stale: boolean;
    ageMs: number;
    /** Which of the six freshness states the snapshot behind this payload is. */
    freshness: MarketFreshness;
    /** Which venue actually answered. */
    provider: string;
}

/**
 * `instrument` is optional and defaults to the configured market, so the frozen
 * `/api/analysis` is a call with nothing extra rather than a separate code path.
 */
export async function getAnalysis(
    logger?: FastifyBaseLogger,
    requestId?: string,
    instrument?: string | undefined,
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
            // Narrowed on the way in rather than passed wholesale, so the
            // analysis cannot reach a level the controller did not intend to
            // give it. Both methods, because a log that can only report
            // successes cannot report a run that half-worked.
            error: (
                context: Parameters<FastifyBaseLogger['error']>[0],
                message: string,
            ): void => {
                logger.error(context, message);
            },
        };

    const { analysis, stale, ageMs, freshness, provider } =
        await analyzeMarketWithStatus(
            adapter,
            requestId,
            logger,
            instrument,
        );

    return {
        payload: MarketAnalysisSchema.parse(analysis),
        stale,
        ageMs,
        freshness,
        provider,
    };
}
