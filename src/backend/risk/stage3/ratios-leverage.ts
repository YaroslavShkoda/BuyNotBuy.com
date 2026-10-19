import type { FiniteNumber, Result } from '../../types/margin-assessment.js';
import { compare, divide, type ExactRational, fromBinary64, multiply, type NumericResult, publish } from './arithmetic.js';
import { type PreparedMarginInput, readCanonicalMarginInput } from './canonicalization.js';
import { calculateMarginRequirements } from './margin-requirements.js';
import { calculatePnlEquity } from './pnl-equity.js';
import { validateStage3Input } from './validation.js';

interface ExactRatiosLeverage {
    /** Internal intermediate; no additional assessment metric. */
    readonly entryNotionalQuote: Result<ExactRational>;
    readonly maintenanceRequirementToEquity: Result<ExactRational>;
    readonly effectiveGrossLeverage: Result<ExactRational>;
    readonly entryCollateralLeverage: Result<ExactRational>;
}

/** Pure mathematical model outputs, with no venue or maintenance verdict. */
export interface RatiosLeverageCalculation {
    readonly exact: ExactRatiosLeverage;
    readonly maintenanceRequirementToEquity: Result<FiniteNumber>;
    readonly effectiveGrossLeverage: Result<FiniteNumber>;
    readonly entryCollateralLeverage: Result<FiniteNumber>;
}

function result<T>(value: NumericResult<T>): Result<T> {
    return value.ok ? { status: 'valid', value: value.value, reasons: [] }
        : { status: 'calculation_error', value: null, reasons: [value.error.code] };
}

function failed<T>(): Result<T> {
    return { status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] };
}

function positiveDenominatorDivision(
    numerator: Result<ExactRational>, denominator: Result<ExactRational>, zero: Result<ExactRational>,
    reason: 'NON_POSITIVE_EQUITY' | 'ZERO_COLLATERAL',
): Result<ExactRational> {
    // Domain preconditions take precedence when the denominator is known. No
    // divide call is made for zero/negative E or zero C, even if another operand
    // is unavailable. Failure to compute the denominator itself is propagated.
    if (denominator.status !== 'valid') return denominator;
    if (zero.status !== 'valid') return zero;
    const order = compare(denominator.value, zero.value);
    if (!order.ok) return result(order);
    if (order.value <= 0) {
        // Negative C cannot pass the supported snapshot schema. Refuse a broken
        // dependency returning it, rather than mislabel it as ZERO_COLLATERAL.
        if (reason === 'ZERO_COLLATERAL' && order.value < 0) return failed();
        return { status: 'not_applicable', value: null, reasons: [reason] };
    }
    if (numerator.status !== 'valid') return numerator;
    return result(divide(numerator.value, denominator.value));
}

function publication(exact: Result<ExactRational>): Result<FiniteNumber> {
    return exact.status === 'valid' ? result(publish(exact.value)) : exact;
}

function finish(exact: ExactRatiosLeverage): RatiosLeverageCalculation {
    return { exact,
        maintenanceRequirementToEquity: publication(exact.maintenanceRequirementToEquity),
        effectiveGrossLeverage: publication(exact.effectiveGrossLeverage),
        entryCollateralLeverage: publication(exact.entryCollateralLeverage),
    };
}

function untrusted(): RatiosLeverageCalculation {
    return finish({ entryNotionalQuote: failed(), maintenanceRequirementToEquity: failed(),
        effectiveGrossLeverage: failed(), entryCollateralLeverage: failed() });
}

/**
 * S3-07 for generic-linear-isolated@1. A dimensionless R=exact MM/exact E,
 * L_effective=exact N/exact E, L_entry=exact(q*e)/exact C. No percent scaling.
 * N/MM come from S3-06, E from S3-05, every numeric operation from S3-04.
 * Existing Result/Reason3 semantics: E<=0 is outside the first two functions'
 * positive-E domain (not_applicable/NON_POSITIVE_EQUITY); C=0 is outside the
 * entry function's domain (not_applicable/ZERO_COLLATERAL). Known domain limits
 * are not arithmetic failures or missing data. C>0 entry leverage is independent
 * of E's sign. These checks are not maintenance threshold classification.
 *
 * Only S3-03 authenticated handles are accepted; parse/revalidate the cached
 * immutable canonical JSON, never arbitrary caller objects or getters. No
 * defaults, alternate rational arithmetic, unchecked brands or rounding inputs.
 * All new exact outcomes precede their separate publications. Any failed source
 * publication (including unavailable positive E) is irrelevant to exact division.
 * Resource refusals are retained for the affected metric without approximation.
 * No configured-leverage, exchange margin-level or liquidation claim is made.
 */
export function calculateRatiosLeverage(handle: PreparedMarginInput): RatiosLeverageCalculation {
    const canonical = readCanonicalMarginInput(handle);
    if (!canonical.ok) return untrusted();
    let raw: unknown;
    try { raw = JSON.parse(canonical.value.inputJson); } catch { return untrusted(); }
    const validated = validateStage3Input(raw);
    if (validated.kind !== 'supported') return untrusted();
    const { snapshot } = validated.input;

    const quantity = result(fromBinary64(snapshot.qtyBase));
    const entry = result(fromBinary64(snapshot.entryPriceQuotePerBase));
    const cash = result(fromBinary64(snapshot.netCashQuote));
    const zero = result(fromBinary64(0));
    const entryNotional = quantity.status !== 'valid' ? quantity : entry.status !== 'valid' ? entry
        : result(multiply(quantity.value, entry.value));
    const equity = calculatePnlEquity(handle).exact.equityQuote;
    const margins = calculateMarginRequirements(handle).exact;
    const ratio = positiveDenominatorDivision(margins.maintenanceMarginQuote, equity, zero, 'NON_POSITIVE_EQUITY');
    const effective = positiveDenominatorDivision(margins.valuationNotionalQuote, equity, zero, 'NON_POSITIVE_EQUITY');
    const entryLeverage = positiveDenominatorDivision(entryNotional, cash, zero, 'ZERO_COLLATERAL');
    return finish({ entryNotionalQuote: entryNotional, maintenanceRequirementToEquity: ratio,
        effectiveGrossLeverage: effective, entryCollateralLeverage: entryLeverage });
}
