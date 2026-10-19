import { createHash } from 'node:crypto';
import type { AssessmentProvenance } from '../../types/margin-assessment.js';
import {
    canonicalAssessmentIdentity, type FoundationResult, MARGIN_CANONICALIZATION_VERSION,
    type PreparedIdentityContext, type PreparedMarginInput, readCanonicalMarginInput, readIdentityContext,
} from './canonicalization.js';

/** Fixed NUL-separated tags, followed by one complete canonical JSON document. */
function digest(domain: 'policy' | 'input' | 'assessment', canonical: string): string {
    return createHash('sha256').update(`BuyNotBuy\0${MARGIN_CANONICALIZATION_VERSION}\0${domain}\0`, 'utf8')
        .update(canonical, 'utf8').digest('hex');
}

export function marginPolicyHash(handle: PreparedMarginInput): FoundationResult<string> {
    const data = readCanonicalMarginInput(handle);
    return data.ok ? { ok: true, value: digest('policy', data.value.policyJson) } : data;
}

export function marginInputHash(handle: PreparedMarginInput): FoundationResult<string> {
    const data = readCanonicalMarginInput(handle);
    return data.ok ? { ok: true, value: digest('input', data.value.inputJson) } : data;
}

export interface MarginIdentity {
    readonly assessmentId: string;
    readonly provenance: AssessmentProvenance;
}

/** Provenance only: no metrics, assessment builder, default versions or global time. */
export function createMarginIdentity(
    handle: PreparedMarginInput, contextHandle: PreparedIdentityContext,
): FoundationResult<MarginIdentity> {
    const data = readCanonicalMarginInput(handle);
    if (!data.ok) return data;
    const context = readIdentityContext(contextHandle);
    if (!context.ok) return context;
    const inputHash = digest('input', data.value.inputJson);
    const canonical = canonicalAssessmentIdentity(inputHash, contextHandle);
    if (!canonical.ok) return canonical;
    return { ok: true, value: Object.freeze({
        assessmentId: digest('assessment', canonical.value),
        provenance: Object.freeze({
            ...data.value.provenance,
            canonicalizationVersion: MARGIN_CANONICALIZATION_VERSION,
            inputHash, policyHash: digest('policy', data.value.policyJson),
            engineVersion: context.value.engineVersion, arithmeticVersion: context.value.arithmeticVersion,
        }),
    }) };
}
