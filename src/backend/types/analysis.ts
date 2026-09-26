import type { MarketIndicators } from '../indicators/indicator.service.js';
import type { SignalResult } from '../signals/signal.types.js';
import type { DivergenceAnalysis } from '../indicators/divergence.service.js';

export interface MomentumAnalysis {
    period: number;
    current: number;
    series: Array<number | null>;
}

/**
 * Periods every indicator was actually computed with.
 *
 * Sent rather than hardcoded in the UI, for the same reason the indicator
 * carries a key: the label "ATR 14" is a claim about the computation, and a
 * label written into a component goes stale the moment the period is changed
 * in the environment. It would then describe a number that was not produced.
 */
export interface IndicatorPeriods {
    ema: number;
    stochastic: number;
    momentum: number;
    atr: number;
    rsi: number;
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
}

export interface MarketAnalysis {
    timestamp: number;
    price: number;
    indicators: MarketIndicators;
    signal: SignalResult;
    momentum: MomentumAnalysis;
    divergence: DivergenceAnalysis;
    periods: IndicatorPeriods;
}
