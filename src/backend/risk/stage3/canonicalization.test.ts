import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    canonicalAssessmentIdentity, canonicalizeMarginJson, prepareIdentityContextJson, prepareMarginInputJson,
    readCanonicalMarginInput, readIdentityContext,
} from './canonicalization.js';
import { baseline, contextHandle, corpus, inputHandle, value } from './test-support/identity-fixtures.js';

function reverseKeys(raw: unknown): unknown {
    if (Array.isArray(raw)) return raw.map(reverseKeys);
    if (raw !== null && typeof raw === 'object') {
        return Object.fromEntries(Object.entries(raw).reverse().map(([key, child]) => [key, reverseKeys(child)]));
    }
    return raw;
}

describe('margin-canonical-json/1 independent vectors', () => {
    for (const vector of corpus.generic) {
        it(vector.name, () => {
            expect(value(canonicalizeMarginJson(vector.json))).toBe(vector.canonical);
            expect(value(canonicalizeMarginJson(vector.canonical))).toBe(vector.canonical);
            expect(value(canonicalizeMarginJson(JSON.stringify(reverseKeys(JSON.parse(vector.json)))))).toBe(vector.canonical);
        });
    }

    it('orders integer-like object names lexically, not by JS enumeration order', () => {
        expect(value(canonicalizeMarginJson('{"2":2,"10":10,"1":1}'))).toBe('{"1":1,"10":10,"2":2}');
    });

    it('preserves array order, Unicode distinctions and isolated surrogate code units', () => {
        expect(value(canonicalizeMarginJson('[1,2]'))).not.toBe(value(canonicalizeMarginJson('[2,1]')));
        expect(value(canonicalizeMarginJson('"é"'))).not.toBe(value(canonicalizeMarginJson('"e\\u0301"')));
        expect(value(canonicalizeMarginJson('"\\ud800"'))).toBe('"\\ud800"');
        expect(value(canonicalizeMarginJson('"\\ud801"'))).not.toBe(value(canonicalizeMarginJson('"\\ud800"')));
        expect(value(canonicalizeMarginJson('"\\u0000"'))).toBe('"\\u0000"');
    });

    it('normalizes signed zero explicitly and keeps all other extreme binary64 values', () => {
        expect(value(canonicalizeMarginJson('-0'))).toBe('0');
        expect(value(canonicalizeMarginJson('0'))).toBe('0');
        for (const number of [Number.MIN_VALUE, 2 * Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** -1022]) {
            const canonical = value(canonicalizeMarginJson(String(number)));
            expect(Object.is(JSON.parse(canonical), number)).toBe(true);
        }
    });
});

describe('JSON text trust boundary', () => {
    it.each(['', '{', 'undefined', 'NaN', 'Infinity', '1n', '{"x":undefined}', '"\u0000"'])(
        'returns a controlled syntax error for %s', (text) => {
            expect(canonicalizeMarginJson(text)).toEqual({ ok: false, error: { code: 'INVALID_JSON' } });
        },
    );

    it('rejects finite-syntax numeric overflow anywhere, without JSON.stringify replacing it with null', () => {
        for (const text of ['1e309', '-1e309', '{"ignored":[1e999]}']) {
            expect(canonicalizeMarginJson(text)).toEqual({ ok: false, error: { code: 'NON_FINITE_NUMBER' } });
            expect(prepareMarginInputJson(text)).toEqual({ kind: 'invalid_json', code: 'NON_FINITE_NUMBER' });
        }
    });

    it('refuses arbitrary objects without invoking getters, proxy traps or coercion hooks', () => {
        let calls = 0;
        const trap = () => { calls += 1; throw new Error('must not execute'); };
        const object = { get snapshot() { return trap(); }, toJSON: trap, toString: trap, [Symbol.toPrimitive]: trap };
        const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
        for (const raw of [object, proxy, 1n, NaN, Infinity, null, undefined, [], new String('{}')]) {
            expect(canonicalizeMarginJson(raw)).toEqual({ ok: false, error: { code: 'JSON_TEXT_REQUIRED' } });
            expect(prepareMarginInputJson(raw)).toEqual({ kind: 'invalid_json', code: 'JSON_TEXT_REQUIRED' });
            expect(prepareIdentityContextJson(raw)).toEqual({ ok: false, error: { code: 'JSON_TEXT_REQUIRED' } });
        }
        expect(calls).toBe(0);
    });

    it('treats prototype-related JSON names as ordinary data without prototype pollution', () => {
        const text = '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}';
        expect(value(canonicalizeMarginJson(text))).toBe(text);
        const raw = JSON.parse(JSON.stringify(baseline())) as Record<string, unknown>;
        Object.defineProperty(raw, '__proto__', { value: { polluted: true }, enumerable: true });
        expect(prepareMarginInputJson(JSON.stringify(raw)).kind).toBe('invalid');
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });

    it('enforces byte, depth and node budgets before canonical serialization', () => {
        expect(canonicalizeMarginJson(JSON.stringify('a'.repeat(16_382))).ok).toBe(true);
        expect(canonicalizeMarginJson(JSON.stringify('a'.repeat(16_383)))).toEqual({ ok: false, error: { code: 'JSON_LIMIT_EXCEEDED' } });
        expect(canonicalizeMarginJson('['.repeat(33) + '0' + ']'.repeat(33))).toEqual({ ok: false, error: { code: 'JSON_LIMIT_EXCEEDED' } });
        expect(canonicalizeMarginJson('[' + Array(4096).fill('0').join(',') + ']')).toEqual({ ok: false, error: { code: 'JSON_LIMIT_EXCEEDED' } });
        expect(canonicalizeMarginJson('[' + Array(4095).fill('0').join(',') + ']').ok).toBe(true);
    });

    it('pins depth semantics exactly: root at depth 0, thirty-three levels admissible, the thirty-fourth rejects', () => {
        const nested = (levels: number): string => '['.repeat(levels) + '0' + ']'.repeat(levels);
        const objects = (levels: number): string => `${'{"a":'.repeat(levels)}0${'}'.repeat(levels)}`;
        // Thirty-two containers put the leaf at depth 32 - the thirty-third node
        // level - and stay admissible, whatever the container kind.
        expect(value(canonicalizeMarginJson(nested(32)))).toBe(nested(32));
        expect(value(canonicalizeMarginJson(objects(32)))).toBe(objects(32));
        // A leaf at depth 33 is the thirty-fourth level and crosses the limit
        // ahead of schema validation, on every entry point into the parser.
        expect(canonicalizeMarginJson(nested(33))).toEqual({ ok: false, error: { code: 'JSON_LIMIT_EXCEEDED' } });
        expect(canonicalizeMarginJson(objects(33))).toEqual({ ok: false, error: { code: 'JSON_LIMIT_EXCEEDED' } });
        expect(prepareMarginInputJson(nested(33))).toEqual({ kind: 'invalid_json', code: 'JSON_LIMIT_EXCEEDED' });
    });

    it('does not issue input handles for malformed, unsupported or extended model documents', () => {
        const cross = baseline();
        Object.assign(cross.snapshot, { marginMode: 'cross' });
        expect(prepareMarginInputJson(JSON.stringify(cross)).kind).toBe('unsupported');
        const invalid = baseline();
        invalid.snapshot.qtyBase = 0;
        expect(prepareMarginInputJson(JSON.stringify(invalid)).kind).toBe('invalid');
        expect(prepareMarginInputJson(JSON.stringify({ ...baseline(), venue: 'claimed' })).kind).toBe('invalid');
    });

    it('stores only immutable canonical documents derived from validated copies', () => {
        const raw = baseline();
        const handle = inputHandle(JSON.stringify(raw));
        const before = value(readCanonicalMarginInput(handle));
        raw.snapshot.positionId = 'changed-after-validation';
        expect(value(readCanonicalMarginInput(handle))).toEqual(before);
        expect(Object.isFrozen(handle)).toBe(true);
        expect(Object.isFrozen(before)).toBe(true);
        expect(Object.isFrozen(before.provenance)).toBe(true);
        expect(readCanonicalMarginInput({} as never)).toEqual({ ok: false, error: { code: 'UNTRUSTED_INPUT' } });
        expect(readIdentityContext(handle as never)).toEqual({ ok: false, error: { code: 'UNTRUSTED_CONTEXT' } });
    });
});

describe('identity context', () => {
    it.each([
        {}, { engineVersion: 'e' }, { arithmeticVersion: 'a' },
        { engineVersion: '', arithmeticVersion: 'a', requestedCapabilities: [] },
        { engineVersion: ' e ', arithmeticVersion: 'a', requestedCapabilities: [] },
        { engineVersion: 'e', arithmeticVersion: null, requestedCapabilities: [] },
        { engineVersion: 'e', arithmeticVersion: 'a' },
        { engineVersion: 'e', arithmeticVersion: 'a', requestedCapabilities: ['cross'] },
        { engineVersion: 'e', arithmeticVersion: 'a', requestedCapabilities: ['margin_metrics', 'margin_metrics'] },
        { engineVersion: 'e', arithmeticVersion: 'a', requestedCapabilities: [], extra: 1 },
    ])('requires explicit versions and capabilities without defaults: %j', (raw) => {
        expect(prepareIdentityContextJson(JSON.stringify(raw))).toEqual({ ok: false, error: { code: 'INVALID_CONTEXT' } });
    });

    it('keeps explicit empty capability sets and sorts nonempty sets', () => {
        const handle = contextHandle('{"engineVersion":"e","arithmeticVersion":"a","requestedCapabilities":[]}');
        expect(value(readIdentityContext(handle)).requestedCapabilities).toEqual([]);
        expect(Object.isFrozen(value(readIdentityContext(handle)).requestedCapabilities)).toBe(true);
        expect(canonicalAssessmentIdentity('invalid', handle)).toEqual({ ok: false, error: { code: 'INVALID_INPUT_HASH' } });
    });

    it('bounds both explicit version identifiers without truncating them', () => {
        const raw = { engineVersion: 'e'.repeat(128), arithmeticVersion: 'a'.repeat(128), requestedCapabilities: [] };
        const handle = contextHandle(JSON.stringify(raw));
        expect(value(readIdentityContext(handle))).toEqual(raw);
        for (const key of ['engineVersion', 'arithmeticVersion'] as const) {
            expect(prepareIdentityContextJson(JSON.stringify({ ...raw, [key]: 'x'.repeat(129) })))
                .toEqual({ ok: false, error: { code: 'INVALID_CONTEXT' } });
        }
    });
});

describe('canonical output limits and closure (S3-03.1)', () => {
    const limitError = { ok: false, error: { code: 'JSON_LIMIT_EXCEEDED' } };

    function expectClosure(text: string): void {
        const first = canonicalizeMarginJson(text);
        if (first.ok) {
            expect(Buffer.byteLength(first.value, 'utf8')).toBeLessThanOrEqual(16_384);
            const second = canonicalizeMarginJson(first.value);
            expect(second.ok).toBe(true);
            if (second.ok) expect(second.value).toBe(first.value);
        } else {
            expect(first).toEqual(limitError);
        }
    }

    it('refuses numeric expansion even when source bytes and value count fit', () => {
        const text = `[${Array(745).fill('1e20').join(',')}]`;
        expect(Buffer.byteLength(text, 'utf8')).toBe(3_726);
        // 745 * (21 digits + comma), plus the array delimiters minus one comma.
        expect(745 * 22 + 1).toBe(16_391);
        expect(canonicalizeMarginJson(text)).toEqual(limitError);
        expectClosure(`[${Array(744).fill('1e20').join(',')}]`);
    });

    it('bounds Unicode expansion at 2730/2731 code units', () => {
        const accepted = value(canonicalizeMarginJson(JSON.stringify('é'.repeat(2_730))));
        expect(accepted).toBe(`"${'\\u00e9'.repeat(2_730)}"`);
        expect(Buffer.byteLength(accepted, 'utf8')).toBe(16_382);
        expectClosure(accepted);
        expect(canonicalizeMarginJson(JSON.stringify('é'.repeat(2_731)))).toEqual(limitError);
    });

    it('accepts exactly 16384 canonical bytes and refuses 16385 after expansion', () => {
        for (const padding of [2, 3]) {
            const text = JSON.stringify('é'.repeat(2_730) + 'a'.repeat(padding));
            expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(16_384);
            const expected = `"${'\\u00e9'.repeat(2_730)}${'a'.repeat(padding)}"`;
            expect(Buffer.byteLength(expected, 'utf8')).toBe(16_382 + padding);
            expect(canonicalizeMarginJson(text)).toEqual(padding === 2
                ? { ok: true, value: expected } : limitError);
            expectClosure(text);
        }
    });

    it('retains source-byte and parsing error precedence', () => {
        expect(canonicalizeMarginJson(' '.repeat(16_385))).toEqual(limitError);
        expect(canonicalizeMarginJson(' '.repeat(16_384))).toEqual({ ok: false, error: { code: 'INVALID_JSON' } });
    });

    it('is closed for expanding decimal literals and Unicode/escape arrays near the byte limit', () => {
        const atom = fc.constantFrom(
            { source: '1e20', canonical: '100000000000000000000' },
            { source: '-1e20', canonical: '-100000000000000000000' },
            { source: '1e-6', canonical: '0.000001' },
            { source: '"é"', canonical: '"\\u00e9"' },
            { source: '"😀"', canonical: '"\\ud83d\\ude00"' },
            { source: '"\\n\\t"', canonical: '"\\u000a\\u0009"' },
            { source: '"\\u00e9"', canonical: '"\\u00e9"' },
            { source: '"\\\\\\\""', canonical: '"\\\\\\\""' },
        );
        fc.assert(fc.property(atom, fc.integer({ min: -4, max: 4 }), (token, offset) => {
            const count = Math.floor((16_384 - 1) / (token.canonical.length + 1)) + offset;
            const text = `[${Array(count).fill(token.source).join(',')}]`;
            const canonical = `[${Array(count).fill(token.canonical).join(',')}]`;
            const accepted = Buffer.byteLength(text, 'utf8') <= 16_384
                && canonical.length <= 16_384 && count + 1 <= 4_096;
            expect(canonicalizeMarginJson(text)).toEqual(accepted ? { ok: true, value: canonical } : limitError);
            expectClosure(text);
        }), { seed: 30311, numRuns: 300 });
    });

    it('is closed for Unicode keys, mixed escapes and strings near the byte limit', () => {
        fc.assert(fc.property(
            fc.constantFrom('é', '😀', '\n', '\ud800', '\\', '"'),
            fc.integer({ min: 2_725, max: 2_735 }), fc.boolean(),
            (unit, count, asKey) => {
                const text = JSON.stringify(asKey ? { [unit.repeat(count)]: 0 } : unit.repeat(count));
                expectClosure(text);
            },
        ), { seed: 30312, numRuns: 150 });
    });

    it('preserves depth and value budgets at their inclusive boundaries', () => {
        fc.assert(fc.property(fc.integer({ min: 30, max: 34 }), fc.integer({ min: 4_060, max: 4_100 }), (depth, count) => {
            const text = '['.repeat(depth) + Array(count).fill('0').join(',') + ']'.repeat(depth);
            expect(canonicalizeMarginJson(text).ok).toBe(depth <= 32 && depth + count <= 4_096);
            expectClosure(text);
        }), { seed: 30313, numRuns: 150 });
        expectClosure('['.repeat(32) + '0' + ']'.repeat(32));
        expectClosure(`[${Array(4_095).fill('0').join(',')}]`);
    });
});

it('round-trips deterministic random JSON values and is independent of key order', () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (raw) => {
        const text = JSON.stringify(raw);
        fc.pre(Buffer.byteLength(text, 'utf8') <= 16_384);
        const result = canonicalizeMarginJson(text);
        fc.pre(result.ok);
        if (!result.ok) return;
        expect(JSON.parse(result.value)).toEqual(JSON.parse(text));
        expect(value(canonicalizeMarginJson(result.value))).toBe(result.value);
        expect(value(canonicalizeMarginJson(JSON.stringify(reverseKeys(raw))))).toBe(result.value);
    }), { seed: 30301, numRuns: 500 });
});

it('preserves deterministic random finite binary64 numbers bit-for-bit except signed zero', () => {
    fc.assert(fc.property(fc.double({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE, noNaN: true }), (number) => {
        const canonical = value(canonicalizeMarginJson(String(number)));
        expect(Object.is(JSON.parse(canonical), number === 0 ? 0 : number)).toBe(true);
    }), { seed: 30302, numRuns: 1000 });
});
