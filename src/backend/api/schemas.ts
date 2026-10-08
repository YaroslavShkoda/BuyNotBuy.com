import { z } from 'zod';
import { DIVERGENCE_TYPES } from '../indicators/divergence.js';
import { ASSET_CATEGORIES, ASSET_STATUSES, MARKET_KINDS, TRADABILITY_REASONS } from '../instruments/domain.js';
import { INDICATOR_KEYS } from '../signals/signal.types.js';
import { SIGNAL_DIRECTIONS } from '../types/direction.js';

/**
 * The refusals, built from the domain's list rather than retyped.
 *
 * The wire has to carry the reason, and the reason is domain vocabulary — so it
 * is read from where the domain keeps it. `z.enum` wants a runtime tuple and a
 * union type is erased at runtime, which is exactly why the list had to be
 * written four times over: there was no value for a validator to be made from.
 * There is now.
 *
 * **The same argument covers every vocabulary below.** A measurement over the
 * tree found twelve sets of three or more strings written in more than one file,
 * and six of them had this shape — a domain vocabulary retyped here because the
 * type alone could not feed a validator. These three are fixed; the rest are
 * recorded rather than swept, because a wide refactor of a frozen module is not
 * a cleanup.
 */
const TradabilityReasonSchema = z.enum(TRADABILITY_REASONS);

export const IndicatorSignalSchema = z.enum(SIGNAL_DIRECTIONS);

export const IndicatorKeySchema = z.enum(INDICATOR_KEYS);

const IndicatorAnalysisSchema = z.object({
    key: IndicatorKeySchema,
    name: z.string(),
    signal: IndicatorSignalSchema,
    reason: z.string(),
    weight: z.number().min(0).max(1),
});

const SignalResultSchema = z.object({
    signal: IndicatorSignalSchema,
    confidence: z.number().min(0).max(100),
    reason: z.string(),
    indicators: z.array(IndicatorAnalysisSchema),
});

const AssetPriceSchema = z.object({
    symbol: z.string(),
    price: z.number(),
});

export const CandleSchema = z.object({
    timestamp: z.number(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
});

export const MarketDataSchema = z.object({
    price: AssetPriceSchema,
    candles: z.array(CandleSchema),
});

const MarketIndicatorsSchema = z.object({
    ema300: z.number(),
    stochastic: z.number(),
    momentum: z.number(),
    atr: z.number().min(0),
    rsi: z.number().min(0).max(100),
    macd: z.object({
        macd: z.number(),
        signal: z.number(),
        histogram: z.number(),
    }),
});

const MomentumAnalysisSchema = z.object({
    period: z.number(),
    current: z.number(),
    series: z.array(z.number().nullable()),
});

const DivergencePointSchema = z.object({
    index: z.number().int().min(0),
    confirmedAtIndex: z.number().int().min(0),
    age: z.number().int().min(0),
    price: z.number(),
    momentum: z.number(),
});

const DivergenceResultSchema = z.object({
    type: z.enum(DIVERGENCE_TYPES),
    previous: DivergencePointSchema,
    current: DivergencePointSchema,
});

export const DivergenceAnalysisSchema = z.object({
    bullish: DivergenceResultSchema.nullable(),
    bearish: DivergenceResultSchema.nullable(),
});

export const MarketAnalysisSchema = z.object({
    timestamp: z.number(),
    price: z.number(),
    indicators: MarketIndicatorsSchema,
    signal: SignalResultSchema,
    momentum: MomentumAnalysisSchema,
    divergence: DivergenceAnalysisSchema,
    periods: z.object({
        ema: z.number(),
        stochastic: z.number(),
        momentum: z.number(),
        atr: z.number(),
        rsi: z.number(),
        macdFast: z.number(),
        macdSlow: z.number(),
        macdSignal: z.number(),
    }),
});

const SignalHistoryEntrySchema = z.object({
    timestamp: z.number(),
    symbol: z.string(),
    signal: IndicatorSignalSchema,
    consensus: z.number().min(0).max(100),
    price: z.number(),
});

const SignalHistoryLastTransitionSchema = z.object({
    from: IndicatorSignalSchema,
    to: IndicatorSignalSchema,
    timestamp: z.number(),
});

const SignalHistorySummarySchema = z.object({
    currentSignal: IndicatorSignalSchema.nullable(),
    // Durations are elapsed hours, so a run that started within the current
    // hour legitimately measures zero.
    currentDurationHours: z.number().int().min(0).nullable(),
    currentDurationBounded: z.boolean(),
    changes24h: z.number().int().min(0),
    lastTransition: SignalHistoryLastTransitionSchema.nullable(),
    previousDurationHours: z.number().int().min(0).nullable(),
    previousDurationBounded: z.boolean(),
    sampleHours: z.number().int().min(0),
});

export const SignalHistoryResponseSchema = z.object({
    entries: z.array(SignalHistoryEntrySchema),
    summary: SignalHistorySummarySchema,
    /**
     * Where to ask for the next, older page, or null at the end of the record.
     *
     * Opaque by design, so it is carried as a string rather than a number:
     * the boundary is an implementation detail and a client that reads one
     * would be reading a promise the format cannot keep.
     */
    nextCursor: z.string().nullable(),
});

export const PriceResponseSchema = AssetPriceSchema;

/**
 * The registry, as a client sees it.
 *
 * **Additive, and that is the whole point.** `/api/analysis` and friends are
 * the frozen contract and stay exactly as they are; these endpoints carry what
 * the asset domain learned and the frozen surface has no room for. Nothing here
 * changes a response the dashboard already draws.
 *
 * `source` is the field worth having. `configured` means a person wrote the
 * asset into the configuration; `learned` means the classification came out of
 * observed data. Collapsing them into a boolean "classified" would make a rule
 * nobody tested indistinguishable from one that was asked for by name, which is
 * exactly what PHASE 14 keeps honest and what an operator reading this needs to
 * see before trusting it.
 */
export const InstrumentAssetSchema = z.object({
    symbol: z.string(),
    category: z.enum(ASSET_CATEGORIES),
    status: z.enum(ASSET_STATUSES),
    source: z.enum(['configured', 'learned']),
});

export const InstrumentSchema = z.object({
    ticker: z.string(),
    base: InstrumentAssetSchema,
    quote: InstrumentAssetSchema,
    market: z.enum(MARKET_KINDS),
    /**
     * The instrument's own status, which is a narrower vocabulary than an
     * asset's: an unclassified asset is a gap, an unclassified instrument has no
     * kind to be unknown about and the schema forbids it. So this is not the
     * domain's `AssetStatus` — it is its own list, deliberately.
     */
    status: z.enum(['active', 'inactive']),
    /**
     * Whether this market may be traded, and why not when it may not.
     *
     * A bare boolean here would be one thing too few — the repository says so
     * where the reason is defined. `unknown_instrument` and `base_inactive` are
     * different incidents fixed by different people, and a client that only
     * receives `false` has to ask a second endpoint to find out which.
     */
    tradable: z.boolean(),
    reason: TradabilityReasonSchema.nullable(),
});

export const InstrumentsResponseSchema = z.object({
    instruments: z.array(InstrumentSchema),
});

export const InstrumentResponseSchema = InstrumentSchema;

/**
 * An instrument that exists but may not be traded, or one that does not.
 *
 * **Strict on purpose, and that is the only reason this schema earns its
 * existence.** Written in round 41 and then not used: the route built its 404
 * body by hand while this sat exported and unread, which is a contract nobody
 * checks. A non-strict object would have fixed that by appearing — it passes any
 * body, including one with a field nobody declared. `.strict()` makes the route
 * and the schema fail together instead: adding a field to the response without
 * deciding whether it is part of the contract becomes a failing test rather than
 * a silent addition.
 */
export const InstrumentProblemSchema = z.object({
    error: z
        .object({
            code: z.string(),
            message: z.string(),
            reason: TradabilityReasonSchema.nullable(),
        })
        .strict(),
});

export const ApiErrorResponseSchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
    }),
});

export type InstrumentDto = z.infer<typeof InstrumentSchema>;
