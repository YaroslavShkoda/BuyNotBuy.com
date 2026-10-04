import { getMarketData } from '../../market/market.service.js';
import { MarketDataSchema } from '../schemas.js';

import type { ControllerResult } from './analysis.controller.js';

export async function getMarket(
    instrument?: string | undefined,
): Promise<ControllerResult<ReturnType<typeof MarketDataSchema.parse>>> {
    const { data, stale, ageMs, freshness, provider } = await getMarketData(
        instrument === undefined ? undefined : { instrument },
    );

    return {
        payload: MarketDataSchema.parse(data),
        stale,
        ageMs,
        freshness,
        provider,
    };
}
