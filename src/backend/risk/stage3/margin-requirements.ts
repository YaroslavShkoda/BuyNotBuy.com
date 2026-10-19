import type { FiniteNumber, Result } from '../../types/margin-assessment.js';
import {
    type ExactRational, fromBinary64, multiply, type NumericResult, publish, subtract,
} from './arithmetic.js';
import { type PreparedMarginInput, readCanonicalMarginInput } from './canonicalization.js';
import { calculatePnlEquity } from './pnl-equity.js';
import { validateStage3Input } from './validation.js';

interface ExactMarginRequirements {
    /** Internal intermediate: the assessment contract has no notional field. */
    readonly valuationNotionalQuote: Result<ExactRational>;
    readonly initialMarginQuote: Result<ExactRational>;
    readonly maintenanceMarginQuote: Result<ExactRational>;
    readonly maintenanceBufferQuote: Result<ExactRational>;
    readonly initialMarginSurplusQuote: Result<ExactRational>;
}

/** Calculation output only; no assessment, breach verdict or venue claims. */
export interface MarginRequirementsCalculation {
    readonly exact: ExactMarginRequirements;
    readonly initialMarginQuote: Result<FiniteNumber>;
    readonly maintenanceMarginQuote: Result<FiniteNumber>;
    readonly maintenanceBufferQuote: Result<FiniteNumber>;
    /** Arithmetic E-IM only; no assertion about permitted exchange actions. */
    readonly initialMarginSurplusQuote: Result<FiniteNumber>;
}

function result<T>(numeric: NumericResult<T>): Result<T> {
    return numeric.ok ? { status: 'valid', value: numeric.value, reasons: [] }
        : { status: 'calculation_error', value: null, reasons: [numeric.error.code] };
}

function combine(
    a: Result<ExactRational>, b: Result<ExactRational>,
    operation: (left: ExactRational, right: ExactRational) => NumericResult<ExactRational>,
): Result<ExactRational> {
    if (a.status !== 'valid') return a;
    if (b.status !== 'valid') return b;
    return result(operation(a.value, b.value));
}

function publication(exact: Result<ExactRational>): Result<FiniteNumber> {
    return exact.status === 'valid' ? result(publish(exact.value)) : exact;
}

function finish(exact: ExactMarginRequirements): MarginRequirementsCalculation {
    return {
        exact,
        initialMarginQuote: publication(exact.initialMarginQuote),
        maintenanceMarginQuote: publication(exact.maintenanceMarginQuote),
        maintenanceBufferQuote: publication(exact.maintenanceBufferQuote),
        initialMarginSurplusQuote: publication(exact.initialMarginSurplusQuote),
    };
}

function untrusted(): MarginRequirementsCalculation {
    const failure: Result<ExactRational> = {
        status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'],
    };
    return finish({
        valuationNotionalQuote: failure, initialMarginQuote: failure,
        maintenanceMarginQuote: failure, maintenanceBufferQuote: failure,
        initialMarginSurplusQuote: failure,
    });
}

/**
 * generic-linear-isolated@1, fixed rates with validated 0<m<i<=1.
 * N=q*p; IM=i*N; MM=m*N; H=E-MM; A=E-IM, without intermediate rounding.
 * A is solely an arithmetic surplus, not permission to withdraw or trade.
 * H=0 and A=0 are numerical boundaries, not maintenance/liquidation decisions.
 *
 * Only authenticated S3-03 handles are accepted. Parse its cached immutable
 * canonical JSON and revalidate the fresh copy, as S3-05 does. No arbitrary
 * caller objects/getters are inspected. There are no financial defaults.
 * S3-05 supplies exact E even if its own PnL/E publications fail. None of its
 * published fields is used in this pipeline. Each new publication is independent
 * and occurs after all five exact values have been computed. N stays internal.
 *
 * All arithmetic and resource limits belong to S3-04. In particular a buffer
 * or surplus can require >4096 reduced bits for valid extreme binary64 inputs;
 * return the kernel's controlled refusal rather than round or clamp to fit.
 * Calculation failure affects only its dependents; publication failure never
 * destroys an exact value. No rational arithmetic or numeric casts live here.
 */
export function calculateMarginRequirements(handle: PreparedMarginInput): MarginRequirementsCalculation {
    const canonical = readCanonicalMarginInput(handle);
    if (!canonical.ok) return untrusted();
    let raw: unknown;
    try { raw = JSON.parse(canonical.value.inputJson); } catch { return untrusted(); }
    const validated = validateStage3Input(raw);
    if (validated.kind !== 'supported') return untrusted();

    const { snapshot, policy } = validated.input;
    const quantity = result(fromBinary64(snapshot.qtyBase));
    const price = result(fromBinary64(snapshot.valuation.priceQuotePerBase));
    const initialRate = result(fromBinary64(policy.initialMarginRate));
    const maintenanceRate = result(fromBinary64(policy.maintenanceMarginRate));
    const notional = combine(quantity, price, multiply);
    const initial = combine(initialRate, notional, multiply);
    const maintenance = combine(maintenanceRate, notional, multiply);
    const equity = calculatePnlEquity(handle).exact.equityQuote;
    const buffer = combine(equity, maintenance, subtract);
    const surplus = combine(equity, initial, subtract);
    return finish({
        valuationNotionalQuote: notional, initialMarginQuote: initial,
        maintenanceMarginQuote: maintenance, maintenanceBufferQuote: buffer,
        initialMarginSurplusQuote: surplus,
    });
}
