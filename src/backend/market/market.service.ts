import { marketDataProvider } from './market.provider';

import type { MarketData } from '../types/market';

export async function getMarketData(): Promise<MarketData> {
    const [price, candles] = await Promise.all([
        marketDataProvider.getPrice(),
        marketDataProvider.getCandles(),
    ]);

    return {
        price,
        candles,
    };
}
