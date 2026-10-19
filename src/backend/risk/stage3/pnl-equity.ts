import type { FiniteNumber, Result } from '../../types/margin-assessment.js';
import {
    add, type ExactRational, fromBinary64, multiply, type NumericErrorCode, type NumericResult,
    publish, subtract,
} from './arithmetic.js';
import { type PreparedMarginInput, readCanonicalMarginInput } from './canonicalization.js';
import { validateStage3Input } from './validation.js';

/** Internal calculation output only, not an assessment or serialized report.
 * Exact handles remain available even when their independent publications fail.
 * No other metrics or maintenance/liquidation decisions are calculated here.
 */
export interface PnlEquityCalculation {
    readonly exact: {
        readonly unrealizedPnlQuote: Result<ExactRational>;
        readonly equityQuote: Result<ExactRational>;
    };
    readonly unrealizedPnlQuote: Result<FiniteNumber>;
    readonly equityQuote: Result<FiniteNumber>;
}

function failed<T>(reason: NumericErrorCode): Result<T> {
    return { status: 'calculation_error', value: null, reasons: [reason] };
}

function result<T>(numeric: NumericResult<T>): Result<T> {
    return numeric.ok ? { status: 'valid', value: numeric.value, reasons: [] } : failed(numeric.error.code);
}

function combine(
    a: NumericResult<ExactRational>, b: NumericResult<ExactRational>,
    operation: (left: ExactRational, right: ExactRational) => NumericResult<ExactRational>,
): NumericResult<ExactRational> {
    if (!a.ok) return a;
    if (!b.ok) return b;
    return operation(a.value, b.value);
}

function finish(pnl: NumericResult<ExactRational>, equity: NumericResult<ExactRational>): PnlEquityCalculation {
    return {
        exact: { unrealizedPnlQuote: result(pnl), equityQuote: result(equity) },
        unrealizedPnlQuote: result(pnl.ok ? publish(pnl.value) : pnl),
        equityQuote: result(equity.ok ? publish(equity.value) : equity),
    };
}

function untrusted(): PnlEquityCalculation {
    const failure: NumericResult<ExactRational> = {
        ok: false, error: { code: 'CALCULATION_FAILED', cause: 'untrusted_value' },
    };
    return finish(failure, failure);
}

/**
 * Only S3-03 module-issued handles are accepted. No caller object is inspected,
 * coerced, or trusted because it happens to satisfy a TypeScript interface.
 * S3-03 exposes immutable canonical JSON rather than a validated data object;
 * parse that cached bounded JSON and revalidate its data copy at this boundary.
 * This does not rehash, recanonicalize or change identity/provenance semantics.
 * Forged/wrapped/revoked handles are refused before parsing or property reads.
 *
 * UPNL = s*q*(p-e); for SHORT, q*(e-p) is the exact equivalent.
 * E = C+UPNL, using the exact handle, never the rounded published number.
 * Each publication is attempted independently after both exact computations.
 * A publication failure does not destroy an otherwise usable exact value.
 * Numeric failures map to existing Result/Reason3, with no fallback or clamp.
 * Negative equity and zero collateral are valid mathematical inputs/results.
 *
 * Resource limits are exclusively S3-04's per-operation limits. This formula
 * has a fixed number of calls. No custom rational or number arithmetic is used.
 */
export function calculatePnlEquity(handle: PreparedMarginInput): PnlEquityCalculation {
    const canonical = readCanonicalMarginInput(handle);
    if (!canonical.ok) return untrusted();
    let raw: unknown;
    try { raw = JSON.parse(canonical.value.inputJson); } catch { return untrusted(); }
    const validated = validateStage3Input(raw);
    if (validated.kind !== 'supported') return untrusted();

    const { snapshot } = validated.input;
    const quantity = fromBinary64(snapshot.qtyBase);
    const entry = fromBinary64(snapshot.entryPriceQuotePerBase);
    const price = fromBinary64(snapshot.valuation.priceQuotePerBase);
    const cash = fromBinary64(snapshot.netCashQuote);
    const difference = snapshot.side === 'LONG'
        ? combine(price, entry, subtract) : combine(entry, price, subtract);
    const pnl = combine(quantity, difference, multiply);
    const equity = combine(cash, pnl, add);
    return finish(pnl, equity);
}
