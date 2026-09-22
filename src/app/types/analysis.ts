export type IndicatorSignal = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface IndicatorAnalysis {
    name: string;
    signal: IndicatorSignal;
    reason: string;
}

export interface SignalResult {
    signal: IndicatorSignal;
    confidence: number;
    reason: string;
    indicators: IndicatorAnalysis[];
}

export interface MarketIndicators {
    ema300: number;
    stochastic: number;
}

export interface MarketAnalysis {
    timestamp: number;
    price: number;
    indicators: MarketIndicators;
    signal: SignalResult;
}
