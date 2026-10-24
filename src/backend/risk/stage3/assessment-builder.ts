import type { CurrencyId, MarginAssessmentV1 } from '../../types/margin-assessment.js';
import { STAGE3_ARITHMETIC_VERSION } from './arithmetic.js';
import {
    type FoundationResult, type PreparedIdentityContext, type PreparedMarginInput,
    prepareIdentityContextJson, readCanonicalMarginInput,
} from './canonicalization.js';
import { createMarginIdentity } from './identity.js';
import { calculateLiquidationBoundary } from './liquidation-boundary.js';
import { calculateMaintenanceVerdict } from './maintenance-verdict.js';
import { calculateMarginRequirements } from './margin-requirements.js';
import { calculatePnlEquity } from './pnl-equity.js';
import { calculateRatiosLeverage } from './ratios-leverage.js';
import { validateStage3Input } from './validation.js';

/**
 * Read-only assembler for the margin-assessment/1 output contract,
 * generic-linear-isolated@1 only. The stage calculators S3-04..S3-09 stay
 * authoritative: this module adds no arithmetic, no rounding and no policy of
 * its own - it runs each calculator once on the same module-issued input
 * handle, copies the published results verbatim into the contract, and derives
 * the assessment status as the worst of its parts. A part that refuses is
 * published as it refused; nothing is retried, defaulted or repaired.
 *
 * Read-only: nothing is written anywhere, nothing is fetched, no clock is
 * read, and the input handle keeps its exact canonical state across a build.
 * Provenance comes exclusively from S3-03 (createMarginIdentity), so the
 * assessment identity is the pinned corpus identity for the same input and
 * context, and nothing else can appear in provenance fields.
 *
 * Scope gating happened upstream at prepareMarginInputJson: a handle cannot
 * exist for an unsupported scope, so this builder never sees spot, cross,
 * inverse or a foreign model, and the capabilities block states the verified
 * flat-model boundary rather than a venue claim (basis.venueConformance stays
 * not_asserted).
 *
 * Status arithmetic mirrors the stage-1 report rule: severity order
 * valid = not_applicable < degraded < insufficient_data < calculation_error,
 * and a zero-severity whole says valid when anything computed, not_applicable
 * only when that is the whole story.
 */

/** Identity of this assembler, declared through the S3-03 context. */
export const MARGIN_ASSESSMENT_BUILDER_VERSION = 'margin-assessment-builder@1' as const;

type AssessmentStatus = MarginAssessmentV1['status'];

const SEVERITY: Readonly<Record<AssessmentStatus, number>> = Object.freeze({
    valid: 0,
    not_applicable: 0,
    degraded: 1,
    insufficient_data: 2,
    calculation_error: 3,
});

function worstAssessmentStatus(statuses: readonly AssessmentStatus[]): AssessmentStatus {
    let worst: AssessmentStatus = 'valid';
    for (const status of statuses) {
        if (SEVERITY[status] > SEVERITY[worst]) worst = status;
    }
    if (SEVERITY[worst] === 0) {
        return statuses.includes('valid') ? 'valid' : 'not_applicable';
    }
    return worst;
}

/**
 * The builder computes all three capabilities on every build, so its own
 * identity context requests exactly those three. Issued through the ordinary
 * S3-03 boundary; canonicalization sorts the capability set.
 */
const CONTEXT_TEXT = JSON.stringify({
    arithmeticVersion: STAGE3_ARITHMETIC_VERSION,
    engineVersion: MARGIN_ASSESSMENT_BUILDER_VERSION,
    requestedCapabilities: ['liquidation_boundary', 'maintenance_comparison', 'margin_metrics'],
});

export function prepareAssessmentContext(): FoundationResult<PreparedIdentityContext> {
    return prepareIdentityContextJson(CONTEXT_TEXT);
}

function untrusted(): { readonly ok: false; readonly error: { readonly code: 'UNTRUSTED_INPUT' } } {
    return { ok: false, error: { code: 'UNTRUSTED_INPUT' } };
}

/**
 * Builds one assessment from trusted S3-03 handles. Errors here mean the
 * caller bypassed the preparation boundary; they are refused before any
 * contract field is assembled, with no partial assessment.
 */
export function buildMarginAssessment(
    inputHandle: PreparedMarginInput,
    contextHandle: PreparedIdentityContext,
): FoundationResult<MarginAssessmentV1> {
    const identity = createMarginIdentity(inputHandle, contextHandle);
    if (!identity.ok) return identity;

    // The quote currency is not part of identity provenance. Read it back from
    // the module-issued canonical document and revalidate, exactly as
    // S3-05..S3-09 do, before any contract field carries it.
    const canonical = readCanonicalMarginInput(inputHandle);
    if (!canonical.ok) return canonical;
    let raw: unknown;
    try {
        raw = JSON.parse(canonical.value.inputJson);
    } catch {
        return untrusted();
    }
    const validated = validateStage3Input(raw);
    if (validated.kind !== 'supported') return untrusted();
    const quoteCurrency = validated.input.snapshot.instrument.quoteCurrency;
    if (!/^[A-Z0-9]{2,12}$/.test(quoteCurrency)) return untrusted();

    const pnl = calculatePnlEquity(inputHandle);
    const requirements = calculateMarginRequirements(inputHandle);
    const ratios = calculateRatiosLeverage(inputHandle);
    const verdict = calculateMaintenanceVerdict(inputHandle);
    const boundary = calculateLiquidationBoundary(inputHandle);

    const metrics = Object.freeze({
        unrealizedPnlQuote: pnl.unrealizedPnlQuote,
        equityQuote: pnl.equityQuote,
        initialMarginQuote: requirements.initialMarginQuote,
        maintenanceMarginQuote: requirements.maintenanceMarginQuote,
        maintenanceBufferQuote: requirements.maintenanceBufferQuote,
        initialMarginSurplusQuote: requirements.initialMarginSurplusQuote,
        maintenanceRequirementToEquity: ratios.maintenanceRequirementToEquity,
        effectiveGrossLeverage: ratios.effectiveGrossLeverage,
        entryCollateralLeverage: ratios.entryCollateralLeverage,
    });

    const assessment: MarginAssessmentV1 = Object.freeze({
        schemaVersion: 'margin-assessment/1',
        assessmentId: identity.value.assessmentId,
        basis: Object.freeze({ kind: 'mathematical_model', venueConformance: 'not_asserted' }),
        provenance: identity.value.provenance,
        quoteCurrency: quoteCurrency as CurrencyId,
        metrics,
        maintenance: verdict.maintenance,
        boundary: boundary.boundary,
        capabilities: Object.freeze({
            boundary: 'verified_flat_model',
            cross: 'unsupported',
            inverse: 'unsupported',
            venueRules: 'unsupported',
        }),
        status: worstAssessmentStatus([
            ...Object.values(metrics).map((metric) => metric.status),
            verdict.maintenance.status,
            boundary.boundary.status,
        ]),
    });

    return { ok: true, value: assessment };
}
