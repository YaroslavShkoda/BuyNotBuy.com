/** Stage 3 output contract only. Independent of risk-report/1 and its vocabulary. */
declare const finiteBrand: unique symbol;
declare const currencyBrand: unique symbol;

/** A future publication boundary must validate before constructing these brands. */
export type FiniteNumber = number & { readonly [finiteBrand]: true };
export type CurrencyId = string & { readonly [currencyBrand]: true };
export type NonEmpty<T> = readonly [T, ...T[]];

export type Reason3 =
    | 'MISSING_INPUT'
    | 'UNSUPPORTED_SCOPE'
    | 'FEATURE_NOT_IMPLEMENTED'
    | 'MODEL_NOT_APPROVED'
    | 'RULES_MISSING'
    | 'RULES_UNVERIFIED'
    | 'RULES_MISMATCH'
    | 'RULES_EXPIRED'
    | 'FORMULA_UNKNOWN'
    | 'FORMULA_UNVERIFIED'
    | 'SNAPSHOT_INCOMPLETE'
    | 'PRICE_BASIS_UNAVAILABLE'
    | 'UNKNOWN_FUNDING'
    | 'NON_POSITIVE_EQUITY'
    | 'ZERO_COLLATERAL'
    | 'NUMERIC_UNDERFLOW'
    | 'NUMERIC_OVERFLOW'
    | 'NUMERIC_RESOURCE_LIMIT'
    | 'CALCULATION_FAILED';

export type Result<T> =
    | {
        readonly status: 'valid';
        readonly value: T;
        readonly reasons: readonly [];
    }
    | {
        readonly status: 'degraded' | 'insufficient_data' | 'not_applicable' | 'calculation_error';
        readonly value: null;
        readonly reasons: NonEmpty<Reason3>;
    };

export interface MaintenanceVerdict {
    readonly exactRelation: 'positive' | 'zero' | 'negative';
    readonly comparison: 'lt' | 'lte';
    readonly state: 'above_threshold' | 'at_threshold' | 'below_threshold';
    readonly detected: boolean;
}

export type BoundaryValue =
    | {
        readonly kind: 'boundary';
        readonly priceQuotePerBase: FiniteNumber;
        readonly publication: 'rounded_exact_boundary';
        readonly boundaryKind: 'root';
        readonly triggersAtExactBoundary: boolean;
        readonly path: 'long_price_decrease' | 'short_price_increase';
        readonly domain: 'positive_real_prices';
    }
    | {
        readonly kind: 'unreachable';
        readonly path: 'long_price_decrease';
        readonly domain: 'positive_real_prices';
        readonly proofId: 'flat-linear-long-cash-ge-entry-notional@1';
    }
    | { readonly kind: 'already_breached' };

export interface AssessmentProvenance {
    readonly inputSchemaVersion: 'margin-model-snapshot/1';
    readonly policySchemaVersion: 'margin-model-policy/1';
    readonly canonicalizationVersion: 'margin-canonical-json/1';
    readonly inputHash: string;
    readonly policyHash: string;
    readonly modelId: 'generic-linear-isolated';
    readonly modelVersion: '1';
    readonly engineVersion: string;
    readonly arithmeticVersion: string;
    readonly source: 'manual' | 'test';
    readonly sourceReference: string;
    readonly snapshotAsOf: number;
    readonly valuationAsOf: number;
}

/** No builder or runtime publication validator exists at the S3-02 stage. */
export interface MarginAssessmentV1 {
    readonly schemaVersion: 'margin-assessment/1';
    readonly assessmentId: string;
    readonly basis: {
        readonly kind: 'mathematical_model';
        readonly venueConformance: 'not_asserted';
    };
    readonly provenance: AssessmentProvenance;
    readonly quoteCurrency: CurrencyId;
    readonly metrics: {
        readonly unrealizedPnlQuote: Result<FiniteNumber>;
        readonly equityQuote: Result<FiniteNumber>;
        readonly initialMarginQuote: Result<FiniteNumber>;
        readonly maintenanceMarginQuote: Result<FiniteNumber>;
        readonly maintenanceBufferQuote: Result<FiniteNumber>;
        readonly initialMarginSurplusQuote: Result<FiniteNumber>;
        readonly maintenanceRequirementToEquity: Result<FiniteNumber>;
        readonly effectiveGrossLeverage: Result<FiniteNumber>;
        readonly entryCollateralLeverage: Result<FiniteNumber>;
    };
    readonly maintenance: Result<MaintenanceVerdict>;
    readonly boundary: Result<BoundaryValue>;
    readonly capabilities: {
        readonly boundary: 'not_implemented' | 'verified_flat_model';
        readonly cross: 'unsupported';
        readonly inverse: 'unsupported';
        readonly venueRules: 'unsupported';
    };
    readonly status: 'valid' | 'degraded' | 'insufficient_data' | 'not_applicable' | 'calculation_error';
}
