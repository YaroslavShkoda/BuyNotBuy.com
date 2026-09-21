import { marketDataProvider } from './market.provider';

import {
    calculateMarketIndicators,
    type MarketIndicators,
} from '../indicators/indicator.service';

import type { MarketData } from '../types/market';

export interface MarketSnapshot {
    market: MarketData;
    indicators: MarketIndicators;
}

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

export async function getMarketSnapshot(): Promise<MarketSnapshot> {
    const market = await getMarketData();

    const indicators = calculateMarketIndicators(market);

    return {
        market,
        indicators,
    };
}

