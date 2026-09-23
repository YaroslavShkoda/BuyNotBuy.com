import type { MarketIndicators } from '../indicators/indicator.service';
import type { SignalResult } from '../signals/signal.types';
import type { DivergenceAnalysis } from '../indicators/divergence.service';

export interface MomentumAnalysis {
    period: number;
    current: number;
    series: Array<number | null>;
}

export interface MarketAnalysis {
    timestamp: number;
    price: number;
    indicators: MarketIndicators;
    signal: SignalResult;
    momentum: MomentumAnalysis;
    divergence: DivergenceAnalysis;
}
