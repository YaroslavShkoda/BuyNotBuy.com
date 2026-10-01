import { z } from 'zod';

export const IndicatorSignalSchema = z.enum([
    'LONG',
    'SHORT',
    'NEUTRAL',
]);

export const IndicatorKeySchema = z.enum(['ema', 'stochastic', 'momentum']);

export const IndicatorAnalysisSchema = z.object({
    key: IndicatorKeySchema,
    name: z.string(),
    signal: IndicatorSignalSchema,
    reason: z.string(),
    weight: z.number().min(0).max(1),
});

export const SignalResultSchema = z.object({
    signal: IndicatorSignalSchema,
    confidence: z.number().min(0).max(100),
    reason: z.string(),
    indicators: z.array(IndicatorAnalysisSchema),
});

export const AssetPriceSchema = z.object({
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

export const MarketIndicatorsSchema = z.object({
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

export const MomentumAnalysisSchema = z.object({
    period: z.number(),
    current: z.number(),
    series: z.array(z.number().nullable()),
});

export const DivergencePointSchema = z.object({
    index: z.number().int().min(0),
    confirmedAtIndex: z.number().int().min(0),
    age: z.number().int().min(0),
    price: z.number(),
    momentum: z.number(),
});

export const DivergenceResultSchema = z.object({
    type: z.enum(['BULLISH', 'BEARISH', 'NONE']),
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

export const SignalHistoryEntrySchema = z.object({
    timestamp: z.number(),
    symbol: z.string(),
    signal: IndicatorSignalSchema,
    consensus: z.number().min(0).max(100),
    price: z.number(),
});

export const SignalHistoryLastTransitionSchema = z.object({
    from: IndicatorSignalSchema,
    to: IndicatorSignalSchema,
    timestamp: z.number(),
});

export const SignalHistorySummarySchema = z.object({
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
    category: z.enum(['crypto', 'fiat']),
    status: z.enum(['active', 'inactive', 'unknown']),
    source: z.enum(['configured', 'learned']),
});

export const InstrumentSchema = z.object({
    ticker: z.string(),
    base: InstrumentAssetSchema,
    quote: InstrumentAssetSchema,
    market: z.enum(['crypto', 'fiat', 'mixed', 'unknown']),
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
    reason: z
        .enum([
            'unknown_instrument',
            'base_inactive',
            'quote_inactive',
            'instrument_inactive',
            'base_unknown',
            'quote_unknown',
        ])
        .nullable(),
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
            reason: z
                .enum([
                    'unknown_instrument',
                    'base_inactive',
                    'quote_inactive',
                    'instrument_inactive',
                    'base_unknown',
                    'quote_unknown',
                ])
                .nullable(),
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

export type IndicatorSignalDto = z.infer<typeof IndicatorSignalSchema>;
export type IndicatorAnalysisDto = z.infer<typeof IndicatorAnalysisSchema>;
export type SignalResultDto = z.infer<typeof SignalResultSchema>;
export type MarketDataDto = z.infer<typeof MarketDataSchema>;
export type MarketAnalysisDto = z.infer<typeof MarketAnalysisSchema>;
export type PriceResponseDto = z.infer<typeof PriceResponseSchema>;
export type SignalHistoryEntryDto = z.infer<typeof SignalHistoryEntrySchema>;
export type SignalHistoryLastTransitionDto = z.infer<typeof SignalHistoryLastTransitionSchema>;
export type SignalHistorySummaryDto = z.infer<typeof SignalHistorySummarySchema>;
export type SignalHistoryResponseDto = z.infer<typeof SignalHistoryResponseSchema>;
