import type { MaintenanceVerdict, Reason3, Result } from '../../types/margin-assessment.js';
import { compare, type ExactRational } from './arithmetic.js';
import { type PreparedMarginInput, readCanonicalMarginInput } from './canonicalization.js';
import { calculateMarginRequirements } from './margin-requirements.js';
import { calculatePnlEquity } from './pnl-equity.js';
import { validateStage3Input } from './validation.js';

/** Internal diagnostics are separate from the publication-eligible verdict. */
export interface MaintenanceCalculation {
    readonly exact: {
        readonly equityQuote: Result<ExactRational>;
        readonly maintenanceMarginQuote: Result<ExactRational>;
        readonly maintenanceBufferQuote: Result<ExactRational>;
        readonly maintenance: Result<MaintenanceVerdict>;
    };
    readonly maintenance: Result<MaintenanceVerdict>;
}

function failed<T>(): Result<T> {
    return { status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] };
}

function classification(
    equity: Result<ExactRational>, maintenance: Result<ExactRational>, comparison: 'lt' | 'lte',
): Result<MaintenanceVerdict> {
    if (equity.status !== 'valid') return equity;
    if (maintenance.status !== 'valid') return maintenance;
    const order = compare(equity.value, maintenance.value);
    if (!order.ok) return { status: 'calculation_error', value: null, reasons: [order.error.code] };
    return { status: 'valid', reasons: [], value: {
        exactRelation: order.value > 0 ? 'positive' : order.value < 0 ? 'negative' : 'zero',
        comparison,
        state: order.value > 0 ? 'above_threshold' : order.value < 0 ? 'below_threshold' : 'at_threshold',
        detected: comparison === 'lt' ? order.value < 0 : order.value <= 0,
    } };
}

function publication(
    exact: Result<MaintenanceVerdict>, equity: Result<unknown>, maintenance: Result<unknown>,
): Result<MaintenanceVerdict> {
    // Stable, deduplicated reasons: E publication, MM publication, exact comparison.
    // H, PnL, IM, A and the ratio publications are not prerequisites.
    const reasons: Reason3[] = [];
    for (const outcome of [equity, maintenance, exact]) {
        for (const reason of outcome.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    }
    const [first, ...rest] = reasons;
    if (first !== undefined) return { status: 'calculation_error', value: null, reasons: [first, ...rest] };
    return exact;
}

function untrusted(): MaintenanceCalculation {
    return { exact: { equityQuote: failed(), maintenanceMarginQuote: failed(),
        maintenanceBufferQuote: failed(), maintenance: failed() }, maintenance: failed() };
}

/**
 * Mathematical maintenance classification for generic-linear-isolated@1 only.
 * Policy comes exclusively from the authenticated, validated input (no default).
 * Compare exact E from S3-05 against exact MM from S3-06 via S3-04; the sign of
 * E-MM is determined without subtracting, publishing, or requiring an H handle.
 * This preserves comparison even if H exceeds the rational component budget.
 * lt breaches below the threshold; lte also breaches at exact equality.
 *
 * Internal classification survives E/MM publication failures, but the public
 * result requires BOTH publications and successful exact comparison. A failure
 * returns null/calculation_error, never a fabricated detected=false. E/MM are
 * not rounded comparison operands. H publication (including under/overflow or
 * resource refusal) has no influence on either comparison or eligibility.
 *
 * Only S3-03 issued handles are accepted, before any caller property reads.
 * Cached bounded immutable JSON is parsed and revalidated as in S3-05–S3-07.
 * All arithmetic/resource policy is inherited; there is no additional arithmetic,
 * finite-number issuance, venue assertion, liquidation action or IO here.
 */
export function calculateMaintenanceVerdict(handle: PreparedMarginInput): MaintenanceCalculation {
    const canonical = readCanonicalMarginInput(handle);
    if (!canonical.ok) return untrusted();
    let raw: unknown;
    try { raw = JSON.parse(canonical.value.inputJson); } catch { return untrusted(); }
    const validated = validateStage3Input(raw);
    if (validated.kind !== 'supported') return untrusted();

    const equity = calculatePnlEquity(handle);
    const margins = calculateMarginRequirements(handle);
    const maintenance = classification(equity.exact.equityQuote, margins.exact.maintenanceMarginQuote, validated.input.policy.comparison);
    return { exact: {
        equityQuote: equity.exact.equityQuote,
        maintenanceMarginQuote: margins.exact.maintenanceMarginQuote,
        maintenanceBufferQuote: margins.exact.maintenanceBufferQuote,
        maintenance,
    }, maintenance: publication(maintenance, equity.equityQuote, margins.maintenanceMarginQuote) };
}
