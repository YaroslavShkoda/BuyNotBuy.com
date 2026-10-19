import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalInputHash } from '../canonical-input.js';
import { bundledFixtureInput } from '../fixtures.js';
import {
    canonicalAssessmentIdentity, prepareMarginInputJson, readCanonicalMarginInput,
} from './canonicalization.js';
import { createMarginIdentity, marginInputHash, marginPolicyHash } from './identity.js';
import { baseline, contextHandle, corpus, inputHandle, value } from './test-support/identity-fixtures.js';

describe('independent Python SHA-256 corpus', () => {
    for (const vector of corpus.identities) {
        it(vector.name, () => {
            const input = inputHandle(vector.inputJson);
            const context = contextHandle(vector.contextJson);
            const canonical = value(readCanonicalMarginInput(input));
            expect(canonical.policyJson).toBe(vector.policyCanonical);
            expect(canonical.inputJson).toBe(vector.inputCanonical);
            expect(value(marginPolicyHash(input))).toBe(vector.policyHash);
            expect(value(marginInputHash(input))).toBe(vector.inputHash);
            expect(value(canonicalAssessmentIdentity(vector.inputHash, context))).toBe(vector.assessmentCanonical);
            const identity = value(createMarginIdentity(input, context));
            expect(identity.assessmentId).toBe(vector.assessmentId);
            const parsed = JSON.parse(vector.inputJson) as ReturnType<typeof baseline>;
            const versions = JSON.parse(vector.contextJson) as { engineVersion: string; arithmeticVersion: string };
            expect(identity.provenance).toEqual({
                inputSchemaVersion: parsed.snapshot.schemaVersion,
                policySchemaVersion: parsed.policy.schemaVersion,
                canonicalizationVersion: 'margin-canonical-json/1',
                inputHash: vector.inputHash, policyHash: vector.policyHash,
                modelId: parsed.policy.modelId, modelVersion: parsed.policy.modelVersion,
                engineVersion: versions.engineVersion, arithmeticVersion: versions.arithmeticVersion,
                source: parsed.snapshot.source.kind, sourceReference: parsed.snapshot.source.reference,
                snapshotAsOf: parsed.snapshot.asOf === 0 ? 0 : parsed.snapshot.asOf,
                valuationAsOf: parsed.snapshot.valuation.asOf === 0 ? 0 : parsed.snapshot.valuation.asOf,
            });
            expect(Object.isFrozen(identity)).toBe(true);
            expect(Object.isFrozen(identity.provenance)).toBe(true);
        });
    }

    it('pins the unchanged legacy risk-report/1 hash independently', () => {
        expect(canonicalInputHash(bundledFixtureInput())).toBe(corpus.legacyFixtureHash);
    });
});

function leaves(raw: object, prefix: string[] = []): string[][] {
    return Object.entries(raw).flatMap(([key, child]) => {
        const path = [...prefix, key];
        return child !== null && typeof child === 'object' ? leaves(child, path) : [path];
    });
}
function get(raw: object, path: string[]): Record<string, unknown> {
    return path.reduce((value, key) => value[key] as Record<string, unknown>, raw as Record<string, unknown>);
}

const replacements: Record<string, unknown> = {
    'snapshot.source.kind': 'test', 'snapshot.instrument.baseCurrency': 'OTHER',
    'snapshot.side': 'SHORT', 'snapshot.valuation.basis': 'mark',
    'policy.initialMarginRate': 0.3, 'policy.maintenanceMarginRate': 0.02,
    'policy.comparison': 'lte',
};
describe('each required input field participates in identity or validation', () => {
    for (const path of leaves(baseline())) {
        it(path.join('.'), () => {
            const raw = baseline();
            const field = path.at(-1);
            if (field === undefined) throw new Error('empty test path');
            const owner = get(raw, path.slice(0, -1));
            const previous = owner[field];
            owner[field] = replacements[path.join('.')] ?? (typeof previous === 'number' ? previous + 1 : `${String(previous)}-changed`);
            const prepared = prepareMarginInputJson(JSON.stringify(raw));
            if (prepared.kind === 'supported') {
                const original = inputHandle();
                expect(value(marginInputHash(prepared.handle))).not.toBe(value(marginInputHash(original)));
                if (path[0] === 'policy') expect(value(marginPolicyHash(prepared.handle))).not.toBe(value(marginPolicyHash(original)));
                else expect(value(marginPolicyHash(prepared.handle))).toBe(value(marginPolicyHash(original)));
            } else {
                expect(['invalid', 'unsupported']).toContain(prepared.kind);
                expect(Object.hasOwn(prepared, 'handle')).toBe(false);
            }
        });
    }

    it('changes coupled currencies and timestamps without violating validation', () => {
        const old = value(marginInputHash(inputHandle()));
        const currency = baseline();
        currency.snapshot.instrument.quoteCurrency = currency.snapshot.instrument.settlementCurrency = 'OTHER';
        expect(value(marginInputHash(inputHandle(JSON.stringify(currency))))).not.toBe(old);
        const time = baseline();
        time.snapshot.asOf = time.snapshot.valuation.asOf = Number.MAX_SAFE_INTEGER;
        expect(value(marginInputHash(inputHandle(JSON.stringify(time))))).not.toBe(old);
    });

    it('accepts maximum-length identifiers and does not normalize Unicode, controls or invisible units', () => {
        const original = value(marginInputHash(inputHandle()));
        for (const reference of ['x'.repeat(256), 'é', 'e\u0301', 'a\u0000b', 'a\nb', 'a\u200bb', '\ud800', '\ud801']) {
            const raw = baseline();
            raw.snapshot.source.reference = reference;
            raw.snapshot.snapshotId = 's'.repeat(128);
            raw.snapshot.positionId = 'p'.repeat(128);
            raw.snapshot.instrument.instrumentId = 'i'.repeat(128);
            const first = value(marginInputHash(inputHandle(JSON.stringify(raw))));
            expect(first).not.toBe(original);
            expect(first).toBe(value(marginInputHash(inputHandle(JSON.stringify(raw)))));
        }
        const composed = baseline();
        composed.snapshot.source.reference = 'é';
        const decomposed = baseline();
        decomposed.snapshot.source.reference = 'e\u0301';
        expect(value(marginInputHash(inputHandle(JSON.stringify(composed)))))
            .not.toBe(value(marginInputHash(inputHandle(JSON.stringify(decomposed)))));
    });
});

describe('identity domain and context separation', () => {
    it('binds versions and requested capability sets, independently of set ordering', () => {
        const handle = inputHandle();
        const build = (engineVersion: string, arithmeticVersion: string, requestedCapabilities: string[]) => value(createMarginIdentity(
            handle, contextHandle(JSON.stringify({ engineVersion, arithmeticVersion, requestedCapabilities })),
        )).assessmentId;
        const original = build('e1', 'a1', ['margin_metrics', 'maintenance_comparison']);
        expect(build('e1', 'a1', ['maintenance_comparison', 'margin_metrics'])).toBe(original);
        for (const next of [build('e2', 'a1', ['margin_metrics', 'maintenance_comparison']),
            build('e1', 'a2', ['margin_metrics', 'maintenance_comparison']), build('e1', 'a1', []),
            build('e1', 'a1', ['liquidation_boundary']), build('e1', 'a1', ['margin_metrics'])]) {
            expect(next).not.toBe(original);
        }
        expect(value(marginPolicyHash(handle))).not.toBe(value(marginInputHash(handle)));
    });

    it('does not collapse ambiguous concatenations or strings containing NUL separators', () => {
        const handle = inputHandle();
        const build = (engineVersion: string, arithmeticVersion: string) => value(createMarginIdentity(
            handle, contextHandle(JSON.stringify({ engineVersion, arithmeticVersion, requestedCapabilities: [] })),
        )).assessmentId;
        expect(build('ab', 'c')).not.toBe(build('a', 'bc'));
        expect(build('a\u0000b', 'c')).not.toBe(build('a', 'b\u0000c'));
        const first = baseline();
        first.snapshot.snapshotId = 'ab'; first.snapshot.positionId = 'c';
        const second = baseline();
        second.snapshot.snapshotId = 'a'; second.snapshot.positionId = 'bc';
        expect(value(marginInputHash(inputHandle(JSON.stringify(first)))))
            .not.toBe(value(marginInputHash(inputHandle(JSON.stringify(second)))));
    });

    it('makes signed zero equivalent in hashing and normalized provenance', () => {
        const json = JSON.stringify({ ...baseline(), snapshot: { ...baseline().snapshot, asOf: 0, netCashQuote: 0,
            valuation: { ...baseline().snapshot.valuation, asOf: 0 } } });
        const negative = json.replaceAll('"asOf":0', '"asOf":-0').replace('"netCashQuote":0', '"netCashQuote":-0');
        const positiveIdentity = value(createMarginIdentity(inputHandle(json), contextHandle()));
        const negativeIdentity = value(createMarginIdentity(inputHandle(negative), contextHandle()));
        expect(negativeIdentity).toEqual(positiveIdentity);
        expect(Object.is(negativeIdentity.provenance.snapshotAsOf, -0)).toBe(false);
        expect(Object.is(negativeIdentity.provenance.valuationAsOf, -0)).toBe(false);
    });

    it('never reads forged handles, including revocable proxies and accessors', () => {
        let calls = 0;
        const trap = () => { calls += 1; throw new Error('must not execute'); };
        const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        for (const forged of [{ get input() { return trap(); } }, proxy, revocable.proxy, {}, Object.create(inputHandle()), null, 1n]) {
            expect(marginPolicyHash(forged as never)).toEqual({ ok: false, error: { code: 'UNTRUSTED_INPUT' } });
            expect(marginInputHash(forged as never)).toEqual({ ok: false, error: { code: 'UNTRUSTED_INPUT' } });
            expect(createMarginIdentity(forged as never, contextHandle())).toEqual({ ok: false, error: { code: 'UNTRUSTED_INPUT' } });
            expect(createMarginIdentity(inputHandle(), forged as never)).toEqual({ ok: false, error: { code: 'UNTRUSTED_CONTEXT' } });
        }
        expect(canonicalAssessmentIdentity(proxy as never, contextHandle())).toEqual({ ok: false, error: { code: 'INVALID_INPUT_HASH' } });
        expect(calls).toBe(0);
    });
});

it('has deterministic field sensitivity over finite binary64 snapshot values', () => {
    fc.assert(fc.property(fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true }), (qty) => {
        const raw = baseline();
        raw.snapshot.qtyBase = qty;
        const first = value(createMarginIdentity(inputHandle(JSON.stringify(raw)), contextHandle()));
        expect(first).toEqual(value(createMarginIdentity(inputHandle(JSON.stringify(raw)), contextHandle())));
        raw.snapshot.side = 'SHORT';
        expect(value(createMarginIdentity(inputHandle(JSON.stringify(raw)), contextHandle())).assessmentId).not.toBe(first.assessmentId);
    }), { seed: 30303, numRuns: 500 });
});
