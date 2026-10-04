import type { MarketDataResult } from '../market/market.service.js';
import type { MarketData } from '../types/market.js';

import { marketDataResult } from './market-data.js';

/**
 * Wraps a market snapshot the way `getMarketData()` does on a healthy fetch,
 * so tests that substitute the market layer can keep writing plain fixtures.
 */
export function freshMarketData(data: MarketData): MarketDataResult {
    return marketDataResult(data);
}
