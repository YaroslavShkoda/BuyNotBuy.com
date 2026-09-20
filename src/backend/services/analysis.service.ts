import type { MarketAnalysis } from '../types/analysis';

import { getMarketData } from '../market/market.service';
import { calculateMarketIndicators } from '../indicators/indicator.service';
import { calculateSignal } from '../signals/signal.service';

export async function analyzeMarket(): Promise<MarketAnalysis> {
    const marketData = await getMarketData();

    const indicators = calculateMarketIndicators(
        marketData,
    );

    const signal = calculateSignal(
        marketData.price.price,
        indicators,
    );

    return {
        timestamp: Date.now(),
        price: marketData.price.price,
        indicators,
        signal,
    };
}
