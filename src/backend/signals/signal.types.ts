export type IndicatorSignal =
    | 'LONG'
    | 'SHORT'
    | 'NEUTRAL';

/**
 * Stable identity of an indicator, separate from its display name.
 *
 * The name is text meant to be read — "Momentum 100" carries a period, so it
 * changes the moment the period becomes configurable. Anything that needs to
 * recognise an indicator has to use this instead, because two things break at
 * once otherwise. The dashboard matches rows by name and renders nothing when
 * the name shifts. And the performance table keys its rows by name, so a
 * renamed indicator starts a new series and orphans every vote already
 * recorded under the old one — history silently split in two.
 */
export type IndicatorKey = 'ema' | 'stochastic' | 'momentum';

export interface IndicatorAnalysis {
    /** Stable across renames and period changes. Never shown to a person. */
    key: IndicatorKey;
    /** Human-readable label, including the period it was computed with. */
    name: string;
    signal: IndicatorSignal;
    reason: string;
    /**
     * Strength of this vote in [0, 1]. Zero means "no opinion", so a neutral
     * indicator stops dragging the consensus down. A vote that barely clears
     * its threshold weighs almost nothing, which is what separates a real
     * consensus from three indicators agreeing on noise.
     */
    weight: number;
}

export interface SignalResult {
    signal: IndicatorSignal;
    confidence: number;
    reason: string;
    indicators: IndicatorAnalysis[];
}
