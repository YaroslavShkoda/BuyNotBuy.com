import { marketConfig } from '../config/market.config.js';
import type { MarketDataResult } from '../market/market.service.js';
import type { MarketFreshness } from '../market/market-freshness.js';
import type { MarketData } from '../types/market.js';

/**
 * A complete `MarketData`, so a test never has to remember the envelope.
 *
 * The fields that identify the snapshot — venue, symbol, interval, market
 * timestamp — are exactly the ones a test forgets, and a fixture that omits
 * them stops being a fixture and starts being a type error in every file that
 * builds one. Deriving the market timestamp from the last candle keeps it
 * truthful: a fixture whose `timestamp` is `Date.now()` while its newest candle
 * closed three hours ago is the same kind of lie the whole freshness model
 * exists to prevent, and it would be in the tests.
 */
export function marketData(
    candles: MarketData['candles'],
    overrides: Partial<Omit<MarketData, 'candles'>> = {},
): MarketData {
    const last = candles.at(-1);
    const price = last?.close ?? 0;

    return {
        price: overrides.price ?? { symbol: marketConfig.symbol, price },
        candles,
        provider: overrides.provider ?? marketConfig.provider,
        symbol: overrides.symbol ?? marketConfig.symbol,
        interval: overrides.interval ?? marketConfig.candleInterval,
        timestamp:
            overrides.timestamp ??
            (last === undefined
                ? 0
                : last.timestamp + marketConfig.candleIntervalMs),
    };
}

export function marketDataResult(
    data: MarketData,
    overrides: Partial<Omit<MarketDataResult, 'data'>> = {},
): MarketDataResult {
    return {
        data,
        stale: false,
        ageMs: 0,
        provider: data.provider,
        freshness: 'fresh',
        ...overrides,
    };
}

export function freshness(value: MarketFreshness): MarketFreshness {
    return value;
}
