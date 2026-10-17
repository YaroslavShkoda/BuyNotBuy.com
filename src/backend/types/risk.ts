import type { CandleInterval } from './candle-interval.js';
import type { MarketProviderName } from './venue.js';

/**
 * The shadow risk model's vocabulary and report shapes.
 *
 * This module states what the shadow risk report IS, separately from anything
 * that computes or validates it, for the same reason `types/analysis.ts`
 * exists: the report is a contract a reader must be able to judge without
 * reading the builder. `types` imports runtime layers in neither direction.
 *
 * Everything here is descriptive. No field of the report feeds a trading
 * decision, and no type here is derived from a signal, a strategy or an
 * analysis shape — the shadow contour is deliberately foreign to the trading
 * vocabulary.
 */

/** How much of the report may be trusted, per metric, section and whole. */
export const RISK_STATUSES = [
    'valid',
    'degraded',
    'insufficient_data',
    'not_applicable',
    'calculation_error',
] as const;

export type RiskStatus = (typeof RISK_STATUSES)[number];

/** The direction of an open position. `NEUTRAL` is not a position. */
export const POSITION_SIDES = ['LONG', 'SHORT'] as const;

export type PositionSide = (typeof POSITION_SIDES)[number];

/** Margining regime, as the venues name it. */
export const MARGIN_MODES = ['isolated', 'cross'] as const;

export type MarginMode = (typeof MARGIN_MODES)[number];

/**
 * The contract kinds stage 1 says anything about. Applicability of margin and
 * funding is keyed by this tuple exhaustively, so a new kind cannot appear
 * without an explicit decision about both.
 */
export const CONTRACT_KINDS = ['spot', 'linear_perp', 'inverse_perp'] as const;

export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** Where the position numbers came from. Never a confirmed exchange account. */
export const POSITION_SOURCES = ['manual', 'test'] as const;

export type PositionSource = (typeof POSITION_SOURCES)[number];

/** Funding applicability. Signed cost is positive when paid, negative when received. */
export const FUNDING_APPLICABILITY: Readonly<
    Record<ContractKind, 'applicable' | 'not_applicable'>
> = {
    spot: 'not_applicable',
    linear_perp: 'applicable',
    inverse_perp: 'applicable',
};

/** Units a metric's `value` is denominated in. The unit travels with the number. */
export const RISK_UNITS = [
    'percent',
    'quote_currency',
    'base_units',
    'atr_units',
    'ratio',
] as const;

export type RiskUnit = (typeof RISK_UNITS)[number];

/**
 * Why a metric is not `valid`, or why a range is wide.
 *
 * A closed set: every warning and every reason code a reader can meet is one of
 * these, so a consumer can switch on the code rather than parse prose.
 */
export const RISK_NOTICE_CODES = [
    'UNKNOWN_FUNDING',
    'FUNDING_NOT_APPLICABLE',
    'MARGIN_NOT_APPLICABLE',
    'MARGIN_RULES_MISSING',
    'MARGIN_RULES_DRAFT',
    'MARGIN_RULES_MISMATCH',
    'CROSS_MARGIN_NOT_ASSESSABLE',
    'MISSING_INVERSE_CONTRACT_PARAMS',
    'LIQUIDATION_FORMULA_UNCONFIRMED',
    'LIQUIDATION_NOT_REACHABLE',
    'IMPOSSIBLE_LIQUIDATION_GEOMETRY',
    'ATR_UNUSABLE',
    'EXIT_PRICE_NOT_PROVIDED',
    'INVALIDATION_LEVEL_NOT_PROVIDED',
    'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
    'CALCULATION_OVERFLOW',
    'INVERSE_SETTLEMENT_NOT_BASE',
    'DATA_QUALITY_LOW',
    'PORTFOLIO_NOT_IMPLEMENTED',
    'STRESS_ENGINE_NOT_IMPLEMENTED',
    'STRESS_RESULTS_NOT_COMPUTED',
] as const;

export type RiskNoticeCode = (typeof RISK_NOTICE_CODES)[number];

export const RISK_REPORT_SCHEMA_VERSION = 'risk-report/1';

export const RISK_ASSUMPTIONS_VERSION = 'risk-assumptions@6';

export const LINEAR_ISOLATED_FORMULA_ID = 'linear_isolated_v1';

export const REPORT_BUILDER_VERSION = 'risk-report-builder@5';

/**
 * Version of the stage-2 position mathematics: exposure, potential PnL,
 * invalidation distances and the execution-cost estimate. Bumped when any of
 * those formulas changes meaning, so two reports with the same version carry
 * comparable numbers.
 */
export const POSITION_MATH_VERSION = 'position-math@4';

/**
 * How an inverse contract's quote-denominated PnL figure is produced: the
 * base-currency PnL between entry and exit, re-valued at the current price.
 * A market-snapshot valuation, not the settlement value at exit.
 */
export const INVERSE_PNL_QUOTE_VALUATION = 'market-snapshot-at-current-price';

/**
 * What an invalidation distance in ATR units is normalized by: the ATR taken
 * as a fraction of the entry price. The liquidation distances keep their own
 * stage-1 convention and are not governed by this tag.
 */
export const INVALIDATION_ATR_PRICE_BASIS = 'entry-price-fraction';

/** One number of the report, with its unit and its own trust level. */
export interface MetricBlock {
    /** Stable identity inside its section, separate from any display name. */
    readonly metricKey: string;
    /**
     * The number, or `null` when there is no honest number.
     *
     * Absent is not zero. `null` with `insufficient_data` means "cannot be
     * computed"; `null` with `degraded` means "computed except for the part
     * this reason names".
     */
    readonly value: number | null;
    readonly unit: RiskUnit;
    readonly status: RiskStatus;
    /** Why the status is not `valid`, from the closed set. */
    readonly reasonCode: RiskNoticeCode | null;
}

/** A machine-readable warning: a code, a scope and a sentence. */
export interface MachineWarning {
    readonly code: RiskNoticeCode;
    readonly scope: 'report' | 'section' | 'metric';
    readonly sectionKey: string | null;
    readonly metricKey: string | null;
    readonly message: string;
}

/**
 * Provenance and quality of the ATR a distance is measured against.
 *
 * `value` is a fraction of price, which is what `calculateATR` returns; a
 * distance in ATR units is only meaningful against this exact reading, so the
 * period, interval, venue, symbol and time travel with it.
 */
export interface AtrRef {
    readonly value: number;
    readonly period: number;
    readonly interval: CandleInterval;
    readonly venue: MarketProviderName;
    readonly symbol: string;
    /** Epoch ms of the bar the ATR was computed at. */
    readonly asOf: number;
}

/**
 * The quality assessment that travelled with the market data.
 *
 * Structurally the same facts `history/data-quality.ts` and
 * `market/market-freshness.ts` produce, carried as plain numbers and strings so
 * the risk layer needs no import edge into those layers. The caller passes
 * what the snapshot path already decided; the risk model re-derives nothing.
 */
export interface QualityBlock {
    /** 0..1, mean of the underlying factor scores. */
    readonly score: number;
    /** The worst factor's score: the gate, not the average. */
    readonly floor: number;
    readonly usable: boolean;
    readonly worst: string | null;
    readonly blockedBy: string | null;
    readonly freshness: string | null;
}

/** A replay of a real market episode. The dataset names where it came from. */
export interface HistoricalScenario {
    readonly kind: 'historical';
    readonly scenarioId: string;
    readonly sourceVenue: string;
    readonly datasetRef: string;
    /** First and last bar of the episode, epoch ms. */
    readonly fromBar: number;
    readonly toBar: number;
    readonly assumptions: readonly string[];
}

/** A generated shock. The generator, its version and its parameters are the provenance. */
export interface SyntheticScenario {
    readonly kind: 'synthetic';
    readonly scenarioId: string;
    readonly generatorId: string;
    readonly generatorVersion: string;
    readonly params: Readonly<Record<string, number | string | boolean | null>>;
    readonly assumptions: readonly string[];
}

export type Scenario = HistoricalScenario | SyntheticScenario;

/**
 * Margin and liquidation rules for one venue, one contract kind, one mode.
 *
 * Handed in by a person, versioned and review-stamped. Nothing here is fetched
 * from an exchange at stage 1, and nothing here is a confirmed venue rule —
 * `reviewStatus` exists so a config nobody has reviewed cannot produce a
 * `valid` liquidation claim.
 */
export interface MarginRules {
    readonly venue: string;
    readonly contractKind: ContractKind;
    readonly mode: MarginMode;
    /** Maintenance margin rate, fraction of notional, (0, 1). */
    readonly maintenanceMarginRate: number;
    /** Initial margin rate, fraction of notional, (0, 1). */
    readonly initialMarginRate: number;
    /**
     * Notional tiers, ascending; the tier with the largest threshold ≤ notional wins.
     *
     * Mutable arrays, deliberately: this shape is also what the validated
     * input carries, and the schema's output is a plain mutable array. The
     * report-facing types keep their readonly discipline; an input config is
     * data a person wrote.
     */
    readonly tiers: {
        readonly notionalThresholdQuote: number;
        readonly maintenanceMarginRate: number;
    }[];
    /** Which documented formula this config is written for. */
    readonly liquidationFormulaId: string;
    /** Currency collateral is denominated in; must match the position's. */
    readonly collateralCurrency: string;
    /** Inverse only: USD per contract; inverse quoteCurrency must be USD, with no FX conversion. */
    readonly contractSizeUsd: number | null;
    /** Inverse contracts only: what the margin is denominated in. */
    readonly marginCurrency: 'base' | 'quote' | null;
    readonly version: string;
    readonly source: 'manual';
    /** Epoch ms the rules were confirmed current. */
    readonly validAsOf: number;
    readonly reviewStatus: 'draft' | 'reviewed';
    readonly limitations: string[];
}

/** Position risk for the one position the input carries. */
export interface PositionRiskSection {
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
    readonly metrics: readonly MetricBlock[];
}

/**
 * Portfolio-level risk.
 *
 * Stage 1 takes exactly one position, so there is nothing here yet — and the
 * report says so rather than presenting position risk under a portfolio name.
 */
export interface PortfolioRiskSection {
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
    readonly metrics: readonly MetricBlock[];
}

/** Stress scenarios, historical and synthetic kept apart end to end. */
export interface StressSection {
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
    readonly historical: readonly HistoricalScenario[];
    readonly synthetic: readonly SyntheticScenario[];
}

/**
 * Whether margin requirements were breached at the assessed moment.
 *
 * `detected` is `false` only when the assessment ran on sufficient data and
 * found no breach. It is `null` whenever the breach could not be assessed —
 * which is a different fact, and the reason codes say which kind of
 * unassessable this was.
 */
export interface MarginViolationSection {
    readonly detected: boolean | null;
    /** The bar the assessment was made at, when a breach was detected. */
    readonly atBar: number | null;
    readonly marginMode: MarginMode | null;
    readonly rulesVersion: string | null;
    /** Equity and the maintenance requirement the verdict came from, in quote currency. */
    readonly equityQuote: number | null;
    readonly maintenanceRequirementQuote: number | null;
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
}

/**
 * What a liquidation would cost, as an estimate.
 *
 * `point.liquidationPriceQuote` is the model's estimate of where the venue
 * would liquidate — it is not a guaranteed execution price, and nothing in
 * this section may be read as one. A range exists only when named scenarios
 * justify it; `basisScenarioIds` names them, and an empty list with non-null
 * bounds is a defect.
 */
export interface LiquidationConsequencesSection {
    readonly point: {
        readonly liquidationPriceQuote: number | null;
        readonly projectedLossQuote: number | null;
    };
    readonly range: {
        readonly low: number | null;
        readonly high: number | null;
        readonly basisScenarioIds: readonly string[];
    };
    /** Why the range is as wide as it is, from the closed set. */
    readonly widthDrivers: readonly RiskNoticeCode[];
    /** The execution model the numbers assume, never a promise. */
    readonly executionAssumptions: {
        readonly feeRate: number;
        readonly slippageRate: number;
        readonly spreadRate: number;
        readonly fundingRatePerInterval: number | null;
    };
    readonly limitations: readonly string[];
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
}

/** How far the market is from the estimated liquidation price. */
export interface DistancesSection {
    /** Percent of current price to the estimated liquidation price. */
    readonly percentDistance: MetricBlock;
    /** The same distance in ATR units, against the exact ATR named below. */
    readonly atrDistance: MetricBlock;
    readonly atr: AtrRef;
}

export interface DataQualitySection extends QualityBlock {
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
}

/** The stage-1 shadow risk report. Versioned by `schemaVersion`. */
export interface RiskReport {
    /** Deterministic from the input hash: the same input yields the same report id. */
    readonly reportId: string;
    readonly inputHash: string;
    readonly schemaVersion: typeof RISK_REPORT_SCHEMA_VERSION;
    readonly modelVersions: {
        readonly reportBuilder: typeof REPORT_BUILDER_VERSION;
        readonly liquidationLinearIsolated: typeof LINEAR_ISOLATED_FORMULA_ID;
        readonly assumptions: typeof RISK_ASSUMPTIONS_VERSION;
        readonly positionMath: typeof POSITION_MATH_VERSION;
    };
    /**
     * Calculation conventions a consumer must know to interpret the numbers.
     * Machine-readable on purpose: a reader should not have to parse prose
     * assumptions to learn which valuation and normalization a figure uses.
     * The content of these tags is pinned by the model and assumptions
     * versions above.
     */
    readonly conventions: {
        readonly inversePnlQuoteValuation: typeof INVERSE_PNL_QUOTE_VALUATION;
        readonly invalidationAtrPriceBasis: typeof INVALIDATION_ATR_PRICE_BASIS;
    };
    /** When the report was built. Separate from the market time below. */
    readonly computedAt: number;
    /** The market time the numbers describe: close of the last closed bar. */
    readonly marketAsOf: number;
    readonly inputs: {
        readonly positionId: string;
        readonly ticker: string;
        readonly venue: MarketProviderName;
        readonly contractKind: ContractKind;
        readonly interval: CandleInterval;
        readonly provider: string;
        readonly candleCount: number;
        readonly firstBarTime: number;
        readonly lastClosedBarTime: number;
        readonly positionSource: PositionSource;
    };
    readonly assumptions: readonly string[];
    readonly positionRisk: PositionRiskSection;
    readonly portfolioRisk: PortfolioRiskSection;
    readonly stress: StressSection;
    readonly marginViolation: MarginViolationSection;
    readonly liquidationConsequences: LiquidationConsequencesSection;
    readonly distances: DistancesSection;
    readonly dataQuality: DataQualitySection;
    readonly warnings: readonly MachineWarning[];
    /** The whole report's trust level, derived — never assumed from "no throw". */
    readonly reportStatus: RiskStatus;
}
