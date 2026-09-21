export type IndicatorSignal =
    | 'LONG'
    | 'SHORT'
    | 'NEUTRAL';

export interface IndicatorAnalysis {
    name: string;
    signal: IndicatorSignal;
    reason: string;
}

export interface SignalResult {
    signal: IndicatorSignal;
    confidence: number;
    reason: string;
}
