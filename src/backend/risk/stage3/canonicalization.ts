import { z } from 'zod';
import type { AssessmentProvenance } from '../../types/margin-assessment.js';
import { type Stage3ValidationResult, validateStage3Input } from './validation.js';

export const MARGIN_CANONICALIZATION_VERSION = 'margin-canonical-json/1';
const MAX_JSON_BYTES = 16_384;
// Depth is measured on the parsed tree, not on the text, and the root sits at
// depth 0. The limit is inclusive: the deepest admissible node is at depth 32,
// so a document may span thirty-three node levels; a leaf at depth 33 - the
// thirty-fourth level - rejects with JSON_LIMIT_EXCEEDED before schema
// validation runs. This boundary is frozen: relaxing either the constant or
// the comparison below would change which documents are admissible, and with
// them every identity, fingerprint and recorded corpus vector built on
// margin-canonical-json/1.
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;

export type FoundationErrorCode = 'JSON_TEXT_REQUIRED' | 'INVALID_JSON' | 'JSON_LIMIT_EXCEEDED'
    | 'NON_FINITE_NUMBER' | 'INVALID_CONTEXT' | 'INVALID_INPUT_HASH' | 'UNTRUSTED_INPUT' | 'UNTRUSTED_CONTEXT';
export type FoundationResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: FoundationErrorCode } };

declare const inputBrand: unique symbol;
declare const contextBrand: unique symbol;
/** Only module-issued handles are trusted; structural assertions cannot forge membership. */
export interface PreparedMarginInput { readonly [inputBrand]: true }
export interface PreparedIdentityContext { readonly [contextBrand]: true }

type InputProvenance = Pick<AssessmentProvenance, 'inputSchemaVersion' | 'policySchemaVersion'
    | 'modelId' | 'modelVersion' | 'source' | 'sourceReference' | 'snapshotAsOf' | 'valuationAsOf'>;
export interface CanonicalMarginInput {
    readonly policyJson: string;
    readonly inputJson: string;
    readonly provenance: InputProvenance;
}

const version = z.string().min(1).max(128).refine((value) => value.trim() === value && value.trim().length > 0);
const contextSchema = z.strictObject({
    engineVersion: version,
    arithmeticVersion: version,
    requestedCapabilities: z.array(z.enum(['margin_metrics', 'maintenance_comparison', 'liquidation_boundary']))
        .max(3).refine((values) => new Set(values).size === values.length),
});
export type IdentityContext = Readonly<Omit<z.infer<typeof contextSchema>, 'requestedCapabilities'>> & {
    readonly requestedCapabilities: readonly z.infer<typeof contextSchema>['requestedCapabilities'][number][];
};

const inputs = new WeakMap<object, CanonicalMarginInput>();
const contexts = new WeakMap<object, IdentityContext>();

type Json = null | boolean | string | number | Json[] | { [key: string]: Json };
const error = (code: FoundationErrorCode): FoundationResult<never> => ({ ok: false, error: { code } });

/** No reviver, object coercion, prototype conversion or user callbacks. */
function parseJsonText(text: unknown): FoundationResult<Json> {
    if (typeof text !== 'string') return error('JSON_TEXT_REQUIRED');
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return error('JSON_LIMIT_EXCEEDED');
    let parsed: Json;
    try { parsed = JSON.parse(text) as Json; } catch { return error('INVALID_JSON'); }
    let nodes = 0;
    function inspect(value: Json, depth: number): FoundationErrorCode | null {
        nodes += 1;
        if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) return 'JSON_LIMIT_EXCEEDED';
        if (typeof value === 'number' && !Number.isFinite(value)) return 'NON_FINITE_NUMBER';
        if (value !== null && typeof value === 'object') {
            for (const child of Object.values(value)) {
                const failure = inspect(child, depth + 1);
                if (failure !== null) return failure;
            }
        }
        return null;
    }
    const failure = inspect(parsed, 0);
    return failure === null ? { ok: true, value: parsed } : error(failure);
}

/** ASCII JSON: preserve UTF-16 code units, including isolated surrogates. */
function quote(value: string): string {
    let result = '"';
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit === 34 || unit === 92) result += `\\${value[index]}`;
        else if (unit < 32 || unit > 126) result += `\\u${unit.toString(16).padStart(4, '0')}`;
        else result += value[index];
    }
    return `${result}"`;
}

// PRIVATE: callers cannot pass arbitrary objects here. Values come exclusively
// from JSON.parse, successful schema validation, or the fixed identity payload.
function serialize(value: Json): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return quote(value);
    if (typeof value === 'number') return value === 0 ? '0' : value.toString();
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${quote(key)}:${serialize(value[key] as Json)}`).join(',')}}`;
}

/** Generic format utility; it accepts JSON TEXT, never a JS object. */
export function canonicalizeMarginJson(text: unknown): FoundationResult<string> {
    const parsed = parseJsonText(text);
    if (!parsed.ok) return parsed;
    const canonical = serialize(parsed.value);
    // Escaping and binary64 formatting can expand a bounded source document.
    // Serialization preserves tree depth/node count; bound the bytes as well
    // so every successful output is accepted unchanged on canonicalization.
    return Buffer.byteLength(canonical, 'utf8') > MAX_JSON_BYTES
        ? error('JSON_LIMIT_EXCEEDED') : { ok: true, value: canonical };
}

export type PrepareMarginInputResult =
    | { readonly kind: 'supported'; readonly handle: PreparedMarginInput }
    | Exclude<Stage3ValidationResult, { readonly kind: 'supported' }>
    | { readonly kind: 'invalid_json'; readonly code: FoundationErrorCode };

/** External trust boundary. Arbitrary JS objects, getters and proxies are unsupported. */
export function prepareMarginInputJson(text: unknown): PrepareMarginInputResult {
    const parsed = parseJsonText(text);
    if (!parsed.ok) return { kind: 'invalid_json', code: parsed.error.code };
    const validated = validateStage3Input(parsed.value);
    if (validated.kind !== 'supported') return validated;
    const { snapshot, policy } = validated.input;
    // Serialize the validated copy, not the original parsed/untrusted input.
    const data: CanonicalMarginInput = Object.freeze({
        policyJson: serialize(policy),
        inputJson: serialize(validated.input),
        provenance: Object.freeze({
            inputSchemaVersion: snapshot.schemaVersion, policySchemaVersion: policy.schemaVersion,
            modelId: policy.modelId, modelVersion: policy.modelVersion,
            source: snapshot.source.kind, sourceReference: snapshot.source.reference,
            snapshotAsOf: snapshot.asOf === 0 ? 0 : snapshot.asOf,
            valuationAsOf: snapshot.valuation.asOf === 0 ? 0 : snapshot.valuation.asOf,
        }),
    });
    const handle = Object.freeze({}) as PreparedMarginInput;
    inputs.set(handle, data);
    return { kind: 'supported', handle };
}

export function prepareIdentityContextJson(text: unknown): FoundationResult<PreparedIdentityContext> {
    const parsed = parseJsonText(text);
    if (!parsed.ok) return parsed;
    const validated = contextSchema.safeParse(parsed.value);
    if (!validated.success) return error('INVALID_CONTEXT');
    const data: IdentityContext = Object.freeze({
        ...validated.data,
        // Capabilities are a set. Ordinary JSON arrays elsewhere retain order.
        requestedCapabilities: Object.freeze([...validated.data.requestedCapabilities].sort()),
    });
    const handle = Object.freeze({}) as PreparedIdentityContext;
    contexts.set(handle, data);
    return { ok: true, value: handle };
}

/** WeakMap lookup does not read properties or invoke Proxy traps on a forged handle. */
export function readCanonicalMarginInput(handle: PreparedMarginInput): FoundationResult<CanonicalMarginInput> {
    const data = typeof handle === 'object' && handle !== null ? inputs.get(handle) : undefined;
    return data === undefined ? error('UNTRUSTED_INPUT') : { ok: true, value: data };
}

export function readIdentityContext(handle: PreparedIdentityContext): FoundationResult<IdentityContext> {
    const data = typeof handle === 'object' && handle !== null ? contexts.get(handle) : undefined;
    return data === undefined ? error('UNTRUSTED_CONTEXT') : { ok: true, value: data };
}

/** Fixed internal document: no externally supplied object is serialized. */
export function canonicalAssessmentIdentity(
    inputHash: string, contextHandle: PreparedIdentityContext,
): FoundationResult<string> {
    if (typeof inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(inputHash)) return error('INVALID_INPUT_HASH');
    const context = readIdentityContext(contextHandle);
    if (!context.ok) return context;
    return { ok: true, value: serialize({
        inputHash, engineVersion: context.value.engineVersion,
        arithmeticVersion: context.value.arithmeticVersion,
        requestedCapabilities: [...context.value.requestedCapabilities],
    }) };
}
