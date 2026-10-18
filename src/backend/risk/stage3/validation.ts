import type { z } from 'zod';
import type { NonEmpty, Reason3 } from '../../types/margin-assessment.js';
import { type LinearModelInput, LinearModelInputSchema, Stage3RequestEnvelopeSchema } from './schema.js';

export interface ValidationIssue {
    readonly path: readonly (string | number)[];
    readonly code: z.ZodIssue['code'];
    /** Stable business-invariant identifier, independent of Zod's message text. */
    readonly rule: string | null;
    readonly unknownKeys: readonly string[];
}

export type Stage3ValidationResult =
    | { readonly kind: 'supported'; readonly input: LinearModelInput }
    | { readonly kind: 'invalid'; readonly issues: readonly ValidationIssue[] }
    | {
        readonly kind: 'unsupported';
        readonly status: 'insufficient_data';
        readonly reasons: NonEmpty<Reason3>;
        readonly scope: {
            readonly contractKind: 'spot' | 'linear_perp' | 'inverse_perp';
            readonly marginMode: 'isolated' | 'cross';
            readonly modelId: string;
            readonly modelVersion: string;
        };
    };

function invalid(issues: readonly z.ZodIssue[]): Stage3ValidationResult {
    return {
        kind: 'invalid',
        issues: issues.map((issue): ValidationIssue => ({
            path: issue.path.map((key) => typeof key === 'number' ? key : String(key)),
            code: issue.code,
            rule: issue.code === 'custom' && typeof issue.params?.rule === 'string' ? issue.params.rule : null,
            unknownKeys: issue.code === 'unrecognized_keys' ? [...issue.keys].sort() : [],
        })).sort((a, b) => {
            // Error ordering only; no input hashing or canonicalization.
            const left = JSON.stringify([a.path, a.code, a.rule, a.unknownKeys]);
            const right = JSON.stringify([b.path, b.code, b.rule, b.unknownKeys]);
            return left < right ? -1 : left > right ? 1 : 0;
        }),
    };
}

/**
 * Pure validator for JSON-like data. Malformed requests take precedence over
 * unsupported scope. No fallback, default, coercion, formula, IO or mutation.
 * Venue-specific model IDs are refused just like any other unverified model.
 */
export function validateStage3Input(raw: unknown): Stage3ValidationResult {
    const envelope = Stage3RequestEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return invalid(envelope.error.issues);

    const { snapshot, policy } = envelope.data;
    if (snapshot.instrument.contractKind !== 'linear_perp' || snapshot.marginMode !== 'isolated' ||
        policy.modelId !== 'generic-linear-isolated' || policy.modelVersion !== '1') {
        const reasons: NonEmpty<Reason3> = policy.modelId !== 'generic-linear-isolated'
            ? ['UNSUPPORTED_SCOPE', 'FORMULA_UNKNOWN']
            : policy.modelVersion !== '1'
            ? ['UNSUPPORTED_SCOPE', 'FORMULA_UNVERIFIED']
            : ['UNSUPPORTED_SCOPE'];
        return {
            kind: 'unsupported', status: 'insufficient_data', reasons,
            scope: {
                contractKind: snapshot.instrument.contractKind,
                marginMode: snapshot.marginMode,
                modelId: policy.modelId,
                modelVersion: policy.modelVersion,
            },
        };
    }

    // Revalidate raw data at the supported boundary; never return the broader
    // envelope as a supported input via a type assertion.
    const supported = LinearModelInputSchema.safeParse(raw);
    return supported.success ? { kind: 'supported', input: supported.data } : invalid(supported.error.issues);
}
