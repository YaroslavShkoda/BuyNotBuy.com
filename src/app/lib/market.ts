import { z } from 'zod';

import { MarketInstrumentSchema, MarketResponseSchema } from '../../backend/api/schemas';
import type { CandleInterval } from '../../backend/types/candle-interval';
import { fetchJson } from './api-error';

/**
 * What the market is, as the backend's registry says it — not as a symbol
 * string suggests it. The quote of a pair, its display name and its display
 * form are answers the registry already computed; a page that re-derived them
 * from the ticker would be keeping a second copy of the registry's list and
 * guessing with it.
 *
 * `null` when the ticker does not resolve against the registry: the data
 * still renders, unnamed rather than misnamed, and every consumer degrades to
 * the raw ticker instead of a guessed quote.
 */
export type MarketInstrument = z.infer<typeof MarketInstrumentSchema>;

type MarketResponse = z.infer<typeof MarketResponseSchema>;

export function marketUrl(
    instrument?: string,
    interval?: CandleInterval,
): string {
    const base = process.env.BACKEND_URL;
    const intervalQuery = interval === undefined
        ? ''
        : `?interval=${encodeURIComponent(interval)}`;

    return instrument === undefined
        ? `${base}/api/market${intervalQuery}`
        : `${base}/api/instruments/${encodeURIComponent(instrument)}/market${intervalQuery}`;
}

export async function getMarket(
    instrument?: string,
    interval?: CandleInterval,
): Promise<MarketResponse> {
    return fetchJson(marketUrl(instrument, interval), MarketResponseSchema);
}
