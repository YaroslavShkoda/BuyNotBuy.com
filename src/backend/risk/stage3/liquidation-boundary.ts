import type {
    BoundaryValue, MaintenanceVerdict, Reason3, Result,
} from '../../types/margin-assessment.js';
import {
    add, compare, divide, 
    type ExactRational, fromBinary64, multiply, type NumericResult,publish, rational, subtract,
} from './arithmetic.js';
import { type PreparedMarginInput, readCanonicalMarginInput } from './canonicalization.js';
import { calculateMaintenanceVerdict } from './maintenance-verdict.js';
import { validateStage3Input } from './validation.js';

/** Approved proof identifier from the Stage 3 output contract. */
const FLAT_LONG_PROOF_ID: 'flat-linear-long-cash-ge-entry-notional@1' = 'flat-linear-long-cash-ge-entry-notional@1';

/** Internal exact outcome, separate from the publication value. No published
 * report field, venue claim or liquidation action is derived here.
 */
export type ExactBoundary =
    | { readonly kind: 'root'; readonly rootQuote: ExactRational }
    | { readonly kind: 'none'; readonly proofId: typeof FLAT_LONG_PROOF_ID };

export interface LiquidationBoundaryCalculation {
    readonly exact: {
        /** Exact S3-08 classification at the current valuation price. */
        readonly maintenance: Result<MaintenanceVerdict>;
        /** Exact mathematical boundary, independent of its publication. */
        readonly boundary: Result<ExactBoundary>;
    };
    /** Contract boundary value: boundary price, unreachable proof, or breach. */
    readonly boundary: Result<BoundaryValue>;
}

function failed<T>(reason: Reason3): Result<T> {
    return { status: 'calculation_error', value: null, reasons: [reason] };
}

function numeric<T>(value: NumericResult<T>): Result<T> {
    return value.ok ? { status: 'valid', value: value.value, reasons: [] }
        : { status: 'calculation_error', value: null, reasons: [value.error.code] };
}

function untrusted(): LiquidationBoundaryCalculation {
    return {
        exact: { maintenance: failed('CALCULATION_FAILED'), boundary: failed('CALCULATION_FAILED') },
        boundary: failed('CALCULATION_FAILED'),
    };
}

interface BoundaryOperands {
    readonly quantity: NumericResult<ExactRational>;
    readonly entry: NumericResult<ExactRational>;
    readonly cash: NumericResult<ExactRational>;
    readonly maintenanceRate: NumericResult<ExactRational>;
}

/**
 * Exact root of H(p) = 0 on the positive price domain, generic-linear-isolated@1.
 *
 * LONG:  H(p) = C - q*e + q*(1-m)*p.  With q > 0 and m < 1 the coefficient of p
 * is positive, so H is strictly increasing and the root p* = (q*e - C)/(q*(1-m))
 * is unique when it exists.  C < q*e gives one positive boundary; C = q*e puts
 * the root at p = 0, outside the domain; C > q*e leaves H positive on all of
 * p > 0.  Both non-positive-numerator cases report the approved unreachable
 * proof instead of a price; zero and negative prices are never published.
 *
 * SHORT: H(p) = C + q*e - q*(1+m)*p is strictly decreasing, the numerator
 * q*e + C is strictly positive, so exactly one positive root always exists.
 *
 * Signs of numerator and denominator are compared exactly BEFORE any division,
 * so no spurious zero/negative quotient can be formed.  Resource policy: every
 * reduced intermediate fits the 4096-bit component budget for any valid
 * binary64 inputs - reduced numerators are <= 1024 bits per operand, hence
 * q*e <= 2048, q*e -/+ C <= 3173 (numerator) and its denominator, a power of
 * two, <= 3222 bits; q*(1±m) <= 2099/2148; the divided quotient reduces to
 * <= 3173 bits over <= 2099 because the operand denominators are powers of
 * two, so the odd parts cannot combine.  NUMERIC_RESOURCE_LIMIT is therefore
 * mathematically unreachable from data here; the kernel's controlled refusal
 * is still propagated should an authenticated but broken dependency produce
 * oversized values.
 */
function rootValue(side: 'LONG' | 'SHORT', operands: BoundaryOperands): Result<ExactBoundary> {
    const quantity = operands.quantity;
    if (!quantity.ok) return numeric(quantity);
    const entry = operands.entry;
    if (!entry.ok) return numeric(entry);
    const cash = operands.cash;
    if (!cash.ok) return numeric(cash);
    const maintenanceRate = operands.maintenanceRate;
    if (!maintenanceRate.ok) return numeric(maintenanceRate);
    const zero = rational(0n);
    if (!zero.ok) return numeric(zero);
    const one = rational(1n);
    if (!one.ok) return numeric(one);
    const entryNotional = multiply(quantity.value, entry.value);
    if (!entryNotional.ok) return numeric(entryNotional);
    const marginFactor = side === 'LONG'
        ? subtract(one.value, maintenanceRate.value)
        : add(one.value, maintenanceRate.value);
    if (!marginFactor.ok) return numeric(marginFactor);
    const denominator = multiply(quantity.value, marginFactor.value);
    if (!denominator.ok) return numeric(denominator);
    const denominatorSign = compare(denominator.value, zero.value);
    if (!denominatorSign.ok) return numeric(denominatorSign);
    // Validated 0 < m < 1 and q > 0 make this unreachable; a violation refuses
    // the division instead of trusting it.
    if (denominatorSign.value <= 0) return failed('CALCULATION_FAILED');
    const numerator = side === 'LONG'
        ? subtract(entryNotional.value, cash.value)
        : add(entryNotional.value, cash.value);
    if (!numerator.ok) return numeric(numerator);
    const numeratorSign = compare(numerator.value, zero.value);
    if (!numeratorSign.ok) return numeric(numeratorSign);
    if (side === 'LONG' && numeratorSign.value <= 0) {
        return { status: 'valid', reasons: [], value: { kind: 'none', proofId: FLAT_LONG_PROOF_ID } };
    }
    // SHORT numerator is strictly positive for valid inputs; violation refuses.
    if (numeratorSign.value <= 0) return failed('CALCULATION_FAILED');
    const root = divide(numerator.value, denominator.value);
    if (!root.ok) return numeric(root);
    return { status: 'valid', reasons: [], value: { kind: 'root', rootQuote: root.value } };
}

/**
 * Exact liquidation boundary solver for generic-linear-isolated@1. The root is
 * the price p* with exact E(p*) = exact MM(p*): H(p*) = 0 with no intermediate
 * rounding. H(p*) = 0 follows algebraically from exact field arithmetic; the
 * sign of H on each side of p* (LONG below/SHORT above negative) is verified
 * by the test corpus oracle with exact rationals, not by rounded numbers.
 *
 * The mathematical root does not depend on the policy comparison. The policy
 * appears only as triggersAtExactBoundary on the published boundary: at
 * p = p*, H = 0, which breaches under lte and not under lt. No epsilon shift
 * and no mode-specific root is ever formed.
 *
 * Current state comes exclusively from the exact S3-08 classification at the
 * snapshot price, never from the rounded boundary. The contract carries one
 * BoundaryValue: a current breach (exact H < 0, or <= 0 under lte) occupies
 * it as already_breached even when a positive root also exists - root
 * existence then remains an internal exact fact only. This information loss
 * is a property of the approved single-value contract, not of this solver.
 * An unreachable LONG boundary reports the approved flat-linear proof.
 *
 * Publication of a positive root goes once through S3-04: nearest with
 * ties-to-even, refusing false zeros (NUMERIC_UNDERFLOW), infinity
 * (NUMERIC_OVERFLOW) and negative zero. The published price is a display
 * estimate of the exact boundary, never a reclassification operand. Exact
 * roots survive their own publication failure. Exact H at the snapshot may be
 * compared even when other stage publications fail; boundary eligibility does
 * not read any published S3-05-S3-08 metric.
 *
 * Trust: only S3-03 module-issued handles are accepted, checked before any
 * property read; the cached immutable canonical JSON is parsed and
 * revalidated as in S3-05-S3-08. Forged, wrapped, revoked or wrong-kind
 * handles return CALCULATION_FAILED everywhere without invoking getters or
 * Proxy traps, without defaults and without partial results.
 */
export function calculateLiquidationBoundary(handle: PreparedMarginInput): LiquidationBoundaryCalculation {
    const canonical = readCanonicalMarginInput(handle);
    if (!canonical.ok) return untrusted();
    let raw: unknown;
    try { raw = JSON.parse(canonical.value.inputJson); } catch { return untrusted(); }
    const validated = validateStage3Input(raw);
    if (validated.kind !== 'supported') return untrusted();

    const { snapshot, policy } = validated.input;
    const operands: BoundaryOperands = {
        quantity: fromBinary64(snapshot.qtyBase),
        entry: fromBinary64(snapshot.entryPriceQuotePerBase),
        cash: fromBinary64(snapshot.netCashQuote),
        maintenanceRate: fromBinary64(policy.maintenanceMarginRate),
    };
    const current = calculateMaintenanceVerdict(handle);
    const maintenanceExact = current.exact.maintenance;
    const exact = rootValue(snapshot.side, operands);
    if (maintenanceExact.status === 'valid' && maintenanceExact.value.detected) {
        return {
            exact: { maintenance: maintenanceExact, boundary: exact },
            boundary: { status: 'valid', reasons: [], value: { kind: 'already_breached' } },
        };
    }
    if (maintenanceExact.status !== 'valid') {
        return { exact: { maintenance: maintenanceExact, boundary: exact }, boundary: maintenanceExact };
    }
    if (exact.status !== 'valid') {
        return { exact: { maintenance: maintenanceExact, boundary: exact }, boundary: exact };
    }
    if (exact.value.kind === 'none') {
        return {
            exact: { maintenance: maintenanceExact, boundary: exact },
            boundary: {
                status: 'valid', reasons: [], value: {
                    kind: 'unreachable', path: 'long_price_decrease',
                    domain: 'positive_real_prices', proofId: FLAT_LONG_PROOF_ID,
                },
            },
        };
    }
    const published = publish(exact.value.rootQuote);
    if (!published.ok) {
        return {
            exact: { maintenance: maintenanceExact, boundary: exact },
            boundary: failed(published.error.code),
        };
    }
    return {
        exact: { maintenance: maintenanceExact, boundary: exact },
        boundary: {
            status: 'valid', reasons: [], value: {
                kind: 'boundary', priceQuotePerBase: published.value,
                publication: 'rounded_exact_boundary', boundaryKind: 'root',
                triggersAtExactBoundary: policy.comparison === 'lte',
                path: snapshot.side === 'LONG' ? 'long_price_decrease' : 'short_price_increase',
                domain: 'positive_real_prices',
            },
        },
    };
}
