import type { MarketIndicators } from '../indicators/indicator.service';
import type { SignalResult } from '../signals/signal.types';

export interface MarketAnalysis {
    timestamp: number;
    price: number;
    indicators: MarketIndicators;
    signal: SignalResult;
}
