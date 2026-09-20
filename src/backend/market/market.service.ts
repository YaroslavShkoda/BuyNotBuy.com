import { marketDataProvider } from './market.provider';

import {
    calculateMarketIndicators,
    type MarketIndicators,
} from '../indicators/indicator.service';

import type { MarketData } from '../types/market';

import { marketConfig } from '../config/market.config';

export interface MarketSnapshot {
    market: MarketData;
    indicators: MarketIndicators;
}

export async function getMarketData(): Promise<MarketData> {
    const [price, candles] = await Promise.all([
        marketDataProvider.getBitcoinPrice(),
        marketDataProvider.getBitcoinCandles(
            marketConfig.defaultCandleLimit,
        ),
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
