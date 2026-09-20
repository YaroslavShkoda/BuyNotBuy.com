import { 
    getBitcoinPrice, 
    getBitcoinCandles, 
} from './binance.client';

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

export async function getMarketSnapshot(): Promise<MarketSnapshot> {
    const [price, candles] = await Promise.all([
        getBitcoinPrice(),
        getBitcoinCandles(CANDLE_LIMIT),
    ]);

    const market: MarketData = {
        price,
        candles,
    };

    const indicators = calculateMarketIndicators(market);

    return {
        market,
        indicators,
    };
}