import { readFileSync } from 'node:fs';
import type { FoundationResult, PreparedIdentityContext, PreparedMarginInput } from '../canonicalization.js';
import { prepareIdentityContextJson, prepareMarginInputJson } from '../canonicalization.js';
import type { LinearModelInput } from '../schema.js';

interface IdentityVector {
    name: string;
    inputJson: string;
    contextJson: string;
    policyCanonical: string;
    inputCanonical: string;
    assessmentCanonical: string;
    policyHash: string;
    inputHash: string;
    assessmentId: string;
}
export const corpus = JSON.parse(readFileSync(new URL('canonical-corpus.json', import.meta.url), 'utf8')) as {
    generic: { name: string; json: string; canonical: string }[];
    identities: IdentityVector[];
    legacyFixtureHash: string;
};

export function value<T>(result: FoundationResult<T>): T {
    if (!result.ok) throw new Error(`unexpected foundation error: ${result.error.code}`);
    return result.value;
}

export function baseline(): LinearModelInput {
    const vector = corpus.identities[0];
    if (vector === undefined) throw new Error('missing corpus baseline');
    return JSON.parse(vector.inputJson) as LinearModelInput;
}

export function inputHandle(text = JSON.stringify(baseline())): PreparedMarginInput {
    const prepared = prepareMarginInputJson(text);
    if (prepared.kind !== 'supported') throw new Error(`unexpected input result: ${prepared.kind}`);
    return prepared.handle;
}

export function contextHandle(text?: string): PreparedIdentityContext {
    const vector = corpus.identities[0];
    if (vector === undefined) throw new Error('missing corpus baseline');
    return value(prepareIdentityContextJson(text ?? vector.contextJson));
}
