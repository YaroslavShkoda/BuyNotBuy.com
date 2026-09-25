import { z } from 'zod';

export const IndicatorSignalSchema = z.enum([
    'LONG',
    'SHORT',
    'NEUTRAL',
]);

export const IndicatorAnalysisSchema = z.object({
    name: z.string(),
    signal: IndicatorSignalSchema,
    reason: z.string(),
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
});

export const MomentumAnalysisSchema = z.object({
    period: z.number(),
    current: z.number(),
    series: z.array(z.number().nullable()),
});

export const DivergencePointSchema = z.object({
    index: z.number(),
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
    currentDurationHours: z.number().int().min(1).nullable(),
    currentDurationBounded: z.boolean(),
    changes24h: z.number().int().min(0),
    lastTransition: SignalHistoryLastTransitionSchema.nullable(),
    previousDurationHours: z.number().int().min(1).nullable(),
    previousDurationBounded: z.boolean(),
    sampleHours: z.number().int().min(0),
});

export const SignalHistoryResponseSchema = z.object({
    entries: z.array(SignalHistoryEntrySchema),
    summary: SignalHistorySummarySchema,
});

export const PriceResponseSchema = AssetPriceSchema;

export const ApiErrorResponseSchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
    }),
});

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
