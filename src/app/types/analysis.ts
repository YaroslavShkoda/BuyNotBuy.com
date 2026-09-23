// Frontend view of backend contract (src/backend/types/*).
// Keep field-compatible with backend MarketAnalysis.
export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface AssetPrice {
    symbol: string;
    price: number;
}

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
    momentum: number | null;
}

export interface MarketAnalysis {
    timestamp: number;
    price: number;
    indicators: MarketIndicators;
    signal: SignalResult;
}
