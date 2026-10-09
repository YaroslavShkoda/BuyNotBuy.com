import { z } from 'zod';

import {
    CandleSchema,
    DivergenceAnalysisSchema,
    IndicatorKeySchema,
    IndicatorSignalSchema,
    MarketAnalysisSchema,
} from '../../backend/api/schemas';

// The wire contract, not a mirror of it. Every type here is derived from the
// schema the backend parses with on the way out — the same object this side
// validates with on the way in — so a field renamed or retyped on the backend
// is a compile error here instead of a page drawn from a stale copy.

export type Candle = z.infer<typeof CandleSchema>;

export type IndicatorSignal = z.infer<typeof IndicatorSignalSchema>;

/**
 * Stable identity of an indicator, separate from its display name.
 *
 * The UI matches rows by this, never by `name`. `name` carries the period, so a
 * configurable period would otherwise leave every row blank the moment it
 * changed — the row would stop being recognised as an EMA at all.
 */
export type IndicatorKey = z.infer<typeof IndicatorKeySchema>;

export type IndicatorAnalysis = MarketAnalysis['signal']['indicators'][number];

export type SignalResult = MarketAnalysis['signal'];

export type DivergenceAnalysis = z.infer<typeof DivergenceAnalysisSchema>;

export type MarketAnalysis = z.infer<typeof MarketAnalysisSchema>;
