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

/**
 * Stable identity of an indicator, separate from its display name.
 *
 * The UI matches rows by this, never by `name`. `name` carries the period, so a
 * configurable period would otherwise leave every row blank the moment it
 * changed — the row would stop being recognised as an EMA at all.
 */
export type IndicatorKey = 'ema' | 'stochastic' | 'momentum';

export interface IndicatorAnalysis {
    key: IndicatorKey;
    name: string;
    signal: IndicatorSignal;
    reason: string;
    /** Strength of this vote in [0, 1]; 0 means "no opinion". */
    weight: number;
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
    /** True range as a fraction of price; context, not a vote. */
    atr: number;
    rsi: number;
    macd: {
        macd: number;
        signal: number;
        histogram: number;
    };
}

export interface MomentumAnalysis {
    period: number;
    current: number;
    series: Array<number | null>;
}

export type DivergenceType = 'BULLISH' | 'BEARISH' | 'NONE';

export interface DivergencePoint {
    index: number;
    /** First bar that made this pivot knowable. */
    confirmedAtIndex: number;
    /** Bars elapsed since confirmation. */
    age: number;
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
    /** The periods every indicator was actually computed with. */
    periods: {
        ema: number;
        stochastic: number;
        momentum: number;
        atr: number;
        rsi: number;
        macdFast: number;
        macdSlow: number;
        macdSignal: number;
    };
}
