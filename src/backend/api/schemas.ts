import { z } from 'zod';
import { CandleIntervalSchema } from '../config/market.config.js';
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

/**
 * Every number the wire carries, made impossible to be a lie.
 *
 * `JSON.stringify` turns `NaN` and the Infinities into `null`, so a payload
 * that let one through would arrive as an absent number and keep rendering -
 * the chart would draw a gap as if it were a price. `z.number()` in zod 4
 * already refuses `NaN`; `.finite()` refuses what is left, at the single
 * point every response is parsed, and a violation surfaces as a refusal
 * rather than as a nullified field.
 */
const finiteNumber = z.number().finite();

export const IndicatorSignalSchema = z.enum(SIGNAL_DIRECTIONS);

export const IndicatorKeySchema = z.enum(INDICATOR_KEYS);

const IndicatorAnalysisSchema = z.object({
    key: IndicatorKeySchema,
    name: z.string(),
    signal: IndicatorSignalSchema,
    reason: z.string(),
    weight: finiteNumber.min(0).max(1),
});

const SignalResultSchema = z.object({
    signal: IndicatorSignalSchema,
    confidence: finiteNumber.min(0).max(100),
    reason: z.string(),
    indicators: z.array(IndicatorAnalysisSchema),
});

const AssetPriceSchema = z.object({
    symbol: z.string(),
    price: finiteNumber,
});

export const CandleSchema = z.object({
    timestamp: finiteNumber,
    open: finiteNumber,
    high: finiteNumber,
    low: finiteNumber,
    close: finiteNumber,
    volume: finiteNumber,
});

export const MarketDataSchema = z.object({
    price: AssetPriceSchema,
    candles: z.array(CandleSchema),
});

/**
 * The registry's answer to "what is this market", travelling with its data.
 *
 * Written because the quote currency of a pair used to be re-derived on the
 * client from the symbol string — a longest-suffix guess against a list copied
 * from the one that lives here, and two lists that agree on the day they are
 * written and that nothing holds together afterwards. The split is a lookup,
 * not a rule (`instruments/domain.ts`), the lookup already happened here, and
 * a wire that carries the symbol but not its answer makes every client guess
 * again.
 *
 * `displaySymbol` is the domain's `label()`: the market's own name, which is
 * not always the ticker's own name. A client that formats nothing cannot
 * format it differently from the registry, and a fiat pair arrives as
 * `EUR/USD` rather than being printed as a venue ticker.
 *
 * `null`, not a guessed descriptor, when the ticker does not resolve against
 * the registry. The data still flows — a provider may answer for a market the
 * registry cannot name — and the inability to name it is stated rather than
 * papered over with a default quote.
 */
export const MarketInstrumentSchema = z.object({
    ticker: z.string(),
    base: z.string(),
    quote: z.string(),
    name: z.string(),
    displaySymbol: z.string(),
});

// Additive research metadata belongs to the exact snapshot behind each response.
export const SnapshotContextSchema = z.object({
    provider: z.string(),
    symbol: z.string(),
    interval: CandleIntervalSchema,
    lastBarClosedAt: finiteNumber,
    stale: z.boolean(),
    freshness: z.enum(['fresh', 'provider_failed', 'stale', 'partially_available', 'expired', 'unavailable']),
});

export const ResearchExplanationSchema = z.object({
    confidence: z.object({ model: z.enum(['share', 'wilson', 'mean_conviction']), meaning: z.string(), isProbabilityOfBeingRight: z.literal(false) }),
    quality: z.object({ score: finiteNumber, usable: z.boolean(), worst: z.string().nullable(), blockedBy: z.array(z.string()) }).nullable(),
});

export const MarketResponseSchema = MarketDataSchema.extend({
    snapshot: SnapshotContextSchema.optional(),
    instrument: MarketInstrumentSchema.nullable(),
    /**
     * The bar length the candles below were fetched at.
     *
     * Additive. The candles alone cannot say what their own spacing is — a
     * client inferring it from the timestamp deltas reads the gap in a
     * weekend, not the interval — and a client that can request more than one
     * resolution must be able to tell which one it received.
     */
    interval: CandleIntervalSchema,
});

const MarketIndicatorsSchema = z.object({
    ema300: finiteNumber,
    stochastic: finiteNumber,
    momentum: finiteNumber,
    atr: finiteNumber.min(0),
    rsi: finiteNumber.min(0).max(100),
    macd: z.object({
        macd: finiteNumber,
        signal: finiteNumber,
        histogram: finiteNumber,
    }),
});

const MomentumAnalysisSchema = z.object({
    period: finiteNumber,
    current: finiteNumber,
    series: z.array(finiteNumber.nullable()),
});

const DivergencePointSchema = z.object({
    index: finiteNumber.int().min(0),
    confirmedAtIndex: finiteNumber.int().min(0),
    age: finiteNumber.int().min(0),
    price: finiteNumber,
    momentum: finiteNumber,
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
    snapshot: SnapshotContextSchema.optional(),
    explanation: ResearchExplanationSchema.optional(),
    interval: CandleIntervalSchema,
    timestamp: finiteNumber,
    price: finiteNumber,
    indicators: MarketIndicatorsSchema,
    signal: SignalResultSchema,
    momentum: MomentumAnalysisSchema,
    divergence: DivergenceAnalysisSchema,
    periods: z.object({
        ema: finiteNumber,
        stochastic: finiteNumber,
        momentum: finiteNumber,
        atr: finiteNumber,
        rsi: finiteNumber,
        macdFast: finiteNumber,
        macdSlow: finiteNumber,
        macdSignal: finiteNumber,
    }),
});

const SignalHistoryEntrySchema = z.object({
    timestamp: finiteNumber,
    symbol: z.string(),
    /** The series the entry belongs to; every table row already carries it. */
    interval: z.string(),
    signal: IndicatorSignalSchema,
    consensus: finiteNumber.min(0).max(100),
    price: finiteNumber,
});

const SignalHistoryLastTransitionSchema = z.object({
    from: IndicatorSignalSchema,
    to: IndicatorSignalSchema,
    timestamp: finiteNumber,
});

const SignalHistorySummarySchema = z.object({
    currentSignal: IndicatorSignalSchema.nullable(),
    // Durations are elapsed hours, so a run that started within the current
    // hour legitimately measures zero.
    currentDurationHours: finiteNumber.int().min(0).nullable(),
    currentDurationBounded: z.boolean(),
    changes24h: finiteNumber.int().min(0),
    lastTransition: SignalHistoryLastTransitionSchema.nullable(),
    previousDurationHours: finiteNumber.int().min(0).nullable(),
    previousDurationBounded: z.boolean(),
    sampleHours: finiteNumber.int().min(0),
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
    /**
     * The base asset's name as the configuration registry spells it ("Solana",
     * not "SOL"), or `null` when the registry cannot name an asset the database
     * knows. Sourced from the same pure lookup the market endpoint makes, so a
     * client that searches markets by name never keeps its own symbol-to-name
     * list that drifts from this one.
     */
    name: z.string().nullable(),
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
