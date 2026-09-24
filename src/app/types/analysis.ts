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
    momentum: number;
}

export interface MomentumAnalysis {
    period: number;
    current: number;
    series: Array<number | null>;
}

export type DivergenceType = 'BULLISH' | 'BEARISH' | 'NONE';

export interface DivergencePoint {
    index: number;
    price: number;
    momentum: number;
}

export interface DivergenceResult {
    type: DivergenceType;
    previous: DivergencePoint;
    current: DivergencePoint;
}

export interface DivergenceAnalysis {
    bullish: DivergenceResult | null;
    bearish: DivergenceResult | null;
}

export interface MarketAnalysis {
    timestamp: number;
    price: number;
    indicators: MarketIndicators;
    signal: SignalResult;
    momentum: MomentumAnalysis;
    divergence: DivergenceAnalysis;
}
