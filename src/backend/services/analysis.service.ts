import type { MarketData } from '../types/market';
import type { MarketAnalysis } from '../types/analysis';

import { calculateMarketIndicators } from '../indicators/indicator.service';
import { calculateSignal } from '../signals/signal.service';

export function analyzeMarket(
    marketData: MarketData,
): MarketAnalysis {
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
