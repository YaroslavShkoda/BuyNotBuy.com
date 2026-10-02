import type { SignalDirection } from './direction.js';

/**
 * The published analysis, and every shape it is built from.
 *
 * **This file used to import three types from the layers that compute them, and
 * that was the whole of invariant 13.** `MarketAnalysis` is a frozen contract the
 * frontend reads, it named `MarketIndicatorsWire`, `SignalResult` and
 * `DivergenceAnalysis`, and all three lived in `indicators/` and `signals/`. So
 * the bottom layer reached up into two middle ones, the contract moved whenever
 * the implementation moved, and the declaration that says `types` reaches
 * nothing was false in the file the declaration is about.
 *
 * The shapes now live with the contract instead. That is where this project
 * already puts a shared vocabulary — `SIGNAL_DIRECTIONS` in `direction.ts`,
 * `MARKET_VENUES` in `venue.ts` — and `signal.types.ts` said so in as many words
 * before this change, explaining that `signals/` had been the wrong place for a
 * vocabulary every layer may read.
 *
 * The layers now import these from here, which is the direction the layering
 * allows: `indicators → types`, `signals → types`, and `types` reaching nothing.
 *
 * **Nothing was retyped and no field changed.** The point of the move is that the
 * one home for a shape is the place the contract needs it, not the place that
 * happens to compute it — `MarketIndicatorsWire` still extends
 * `Omit<MarketIndicators, 'ema'>`, so adding a field to the internal result and
 * forgetting the wire is still a compile error rather than a silent omission.
 */

/** Stable identity of an indicator, separate from its display name. */
export const INDICATOR_KEYS = ['ema', 'stochastic', 'momentum'] as const;

export type IndicatorKey = (typeof INDICATOR_KEYS)[number];

/**
 * The old name, kept so nothing that already imports it has to change.
 *
 * Renaming an exported type is a breaking edit for every importer, and this is
 * a cleanup rather than a migration. The vocabulary has a home every layer may
 * import now — see `types/direction.ts` for why `signals/` was the wrong place
 * to have declared it, and for what the layering guard was actually reporting
 * when it objected to `strategies/types.ts` reaching in here.
 */
export type IndicatorSignal = SignalDirection;

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

/**
 * The internal shape seven indicators produce.
 *
 * Kept next to the published one on purpose rather than in the indicator layer,
 * because the published shape is derived from it — `MarketIndicatorsWire` below
 * is an `Omit` of this with `ema` renamed. If the two lived in different layers
 * the derivation would have to be re-typed, and a re-typed derivation is a place
 * where a field can be dropped without a word from the compiler.
 */
export interface MarketIndicators {
    ema: number;
    stochastic: number;
    momentum: number;
    atr: number;
    rsi: number;
    macd: {
        macd: number;
        signal: number;
        histogram: number;
    };
}

/** The published shape. `ema300` is the name the contract has always had. */
export interface MarketIndicatorsWire extends Omit<MarketIndicators, 'ema'> {
    ema300: number;
}

/**
 * Which way a divergence points, and the answer when there is none.
 *
 * A tuple, so the wire can validate it. `api/schemas.ts` retyped these three
 * because `z.enum` wants values and a union is erased at compile time — the same
 * reason every other vocabulary in this project grew a value before a validator
 * could be built from it. `DivergenceService` used to spell out the narrower
 * `'BULLISH' | 'BEARISH'` for the polarity it expected; that is now `Exclude` of
 * this list, which says what it is — two of the three, never `NONE` — instead of
 * saying it by typing the strings out a third time.
 */
export const DIVERGENCE_TYPES = ['BULLISH', 'BEARISH', 'NONE'] as const;

export type DivergenceType = (typeof DIVERGENCE_TYPES)[number];

/** A polarity to look for. `NONE` is an answer, never an expectation. */
export type DivergencePolarity = Exclude<DivergenceType, 'NONE'>;

export interface DivergencePoint {
    index: number;
    /**
     * First bar that made this pivot knowable. A swing low is only confirmed
     * after `rightWindow` further bars, so a pivot must never be presented as
     * a current reading before that bar.
     */
    confirmedAtIndex: number;
    /** Bars elapsed since confirmation, at the end of the analysed window. */
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
    /**
     * The published shape, not the internal one.
     *
     * The backend calls this `ema` and the wire calls it `ema300`, and the
     * conversion is deliberate and total: renaming it everywhere is a breaking
     * change to every client, and a client that starts receiving `undefined`
     * is not something this refactor gets to decide.
     */
    indicators: MarketIndicatorsWire;
    signal: SignalResult;
    momentum: MomentumAnalysis;
    divergence: DivergenceAnalysis;
    periods: IndicatorPeriods;
}
