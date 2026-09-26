import { getMarketData } from '../../market/market.service.js';
import { MarketDataSchema } from '../schemas.js';

import type { ControllerResult } from './analysis.controller.js';

export async function getMarket(): Promise<ControllerResult<ReturnType<typeof MarketDataSchema.parse>>> {
    const { data, stale, ageMs } = await getMarketData();

    return {
        payload: MarketDataSchema.parse(data),
        stale,
        ageMs,
    };
}
