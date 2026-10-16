import { resolveInstrument } from '../../config/asset.registry.js';
import { label } from '../../instruments/domain.js';
import { getMarketData } from '../../market/market.service.js';
import type { CandleInterval } from '../../types/candle-interval.js';
import { MarketResponseSchema } from '../schemas.js';

import type { ControllerResult } from './analysis.controller.js';

export async function getMarket(
    instrument?: string | undefined,
    interval?: CandleInterval | undefined,
): Promise<ControllerResult<ReturnType<typeof MarketResponseSchema.parse>>> {
    const { data, stale, ageMs, freshness, provider } = await getMarketData({
        instrument,
        interval,
    });

    // The split is the registry's, not the client's: the descriptor travels
    // with the data, so a page never guesses a pair's quote out of its symbol
    // again. `null` when the ticker does not resolve — the data still flows,
    // unnamed rather than misnamed. The lookup is a pure read of the
    // configuration registry: no I/O, and no layering crossing into the
    // market service, which stays a provider concern.
    const resolved = resolveInstrument(data.symbol);

    return {
        payload: MarketResponseSchema.parse({
            ...data,
            instrument:
                resolved === null
                    ? null
                    : {
                        ticker: resolved.ticker,
                        base: resolved.base.symbol,
                        quote: resolved.quote.symbol,
                        name: resolved.base.name,
                        displaySymbol: label(resolved),
                    },
        }),
        stale,
        ageMs,
        freshness,
        provider,
    };
}
