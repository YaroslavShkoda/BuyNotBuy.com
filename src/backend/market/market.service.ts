import { marketDataProvider } from './market.provider';

import {
    calculateMarketIndicators,
    type MarketIndicators,
} from '../indicators/indicator.service';

import type { MarketData } from '../types/market';

const CANDLE_LIMIT = 500;

export interface MarketSnapshot {
    market: MarketData;
    indicators: MarketIndicators;
}

export async function getMarketData(): Promise<MarketData> {
    const [price, candles] = await Promise.all([
        marketDataProvider.getBitcoinPrice(),
        marketDataProvider.getBitcoinCandles(CANDLE_LIMIT),
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
