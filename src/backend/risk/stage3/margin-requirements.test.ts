import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import ts from 'typescript-5';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { FiniteNumber, MarginAssessmentV1, Result } from '../../types/margin-assessment.js';
import type { ExactRational } from './arithmetic.js';
import * as arithmetic from './arithmetic.js';
import { type PreparedMarginInput, prepareMarginInputJson } from './canonicalization.js';
import { calculateMarginRequirements, type MarginRequirementsCalculation } from './margin-requirements.js';
import * as pnlEquity from './pnl-equity.js';
import { baseline, contextHandle, inputHandle } from './test-support/identity-fixtures.js';

type Pair = [string, string];
type Key = 'N' | 'IM' | 'MM' | 'H' | 'A';
interface MetricVector {
    exact: { parts: Pair } | { error: string; mathematical: Pair };
    published?: { bits: string } | { error: string };
}
interface Vector {
    name: string; side: 'LONG' | 'SHORT';
    inputs: Record<'q' | 'e' | 'p' | 'cash' | 'i' | 'm', string>;
    equity: Pair; metrics: Record<Key, MetricVector>;
}
const vectors: { cases: Vector[] } = JSON.parse(readFileSync(new URL('test-support/margin-requirements-corpus.json', import.meta.url), 'utf8'));
const names = { N: 'valuationNotionalQuote', IM: 'initialMarginQuote', MM: 'maintenanceMarginQuote', H: 'maintenanceBufferQuote', A: 'initialMarginSurplusQuote' } as const;
const publicKeys = ['IM', 'MM', 'H', 'A'] as const;
function valid<T>(result: Result<T>): T {
    if (result.status !== 'valid') throw Error(result.reasons.join(','));
    return result.value;
}
function numeric<T>(result: arithmetic.NumericResult<T>): T {
    if (!result.ok) throw Error(result.error.code);
    return result.value;
}
const exactNumber = (n: number) => numeric(arithmetic.fromBinary64(n));
function pair(value: ExactRational): Pair {
    const parts = numeric(arithmetic.rationalParts(value));
    return [String(parts.numerator), String(parts.denominator)];
}
function number(raw: string): number {
    const v = new DataView(new ArrayBuffer(8)); v.setBigUint64(0, BigInt(`0x${raw}`)); return v.getFloat64(0);
}
function bits(n: number): string {
    const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, n); return v.getBigUint64(0).toString(16).padStart(16, '0');
}
function handle(q: number, e: number, p: number, cash: number, i: number, m: number, side: 'LONG' | 'SHORT' = 'LONG'): PreparedMarginInput {
    const input = baseline();
    Object.assign(input.snapshot, { qtyBase: q, entryPriceQuotePerBase: e, netCashQuote: cash, side });
    input.snapshot.valuation.priceQuotePerBase = p;
    Object.assign(input.policy, { initialMarginRate: i, maintenanceMarginRate: m });
    return inputHandle(JSON.stringify(input));
}
const calculate = (q: number, e: number, p: number, cash: number, i: number, m: number, side: 'LONG' | 'SHORT' = 'LONG') =>
    calculateMarginRequirements(handle(q, e, p, cash, i, m, side));
const resource = { ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT', cause: 'resource_limit' } } as const;
afterEach(() => vi.restoreAllMocks());

describe('independent Python Fraction golden corpus: exact, resource policy and publication', () => {
    it.each(vectors.cases)('$name', row => {
        const v = row.inputs;
        const actual = calculate(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), row.side);
        for (const key of Object.keys(names) as Key[]) {
            const expected = row.metrics[key];
            const exact = actual.exact[names[key]];
            if ('parts' in expected.exact) expect(pair(valid(exact))).toEqual(expected.exact.parts);
            else expect(exact).toEqual({ status: 'calculation_error', value: null, reasons: [expected.exact.error] });
            if (key === 'N') continue;
            const publication = actual[names[key]];
            const expectedPublication = expected.published!;
            if ('error' in expectedPublication) expect(publication).toEqual({ status: 'calculation_error', value: null, reasons: [expectedPublication.error] });
            else {
                const n = valid(publication);
                expect(bits(n)).toBe(expectedPublication.bits);
                expect(Number.isFinite(n)).toBe(true);
                expect(Object.is(n, -0)).toBe(false);
                if (pair(valid(exact))[0] !== '0') expect(n).not.toBe(0);
            }
        }
    });
});

it('pins equality/sign boundaries and exposes no maintenance verdict or public N', () => {
    const atMM = calculate(2, 8, 8, 2, .25, .125);
    const atIM = calculate(2, 8, 8, 4, .25, .125);
    expect(valid(atMM.maintenanceBufferQuote)).toBe(0);
    expect(pair(valid(atMM.exact.maintenanceBufferQuote))).toEqual(['0', '1']);
    expect(valid(atMM.initialMarginSurplusQuote)).toBe(-2);
    expect(valid(atIM.initialMarginSurplusQuote)).toBe(0);
    expect(valid(atIM.maintenanceBufferQuote)).toBe(2);
    expect(valid(calculate(2, 9, 8, 1, .25, .125).maintenanceBufferQuote)).toBe(-3);
    expect(valid(calculate(2, 8, 8, 6, .25, .125).initialMarginSurplusQuote)).toBe(2);
    expect(Object.keys(atMM).sort()).toEqual(['exact', ...publicKeys.map(k => names[k])].sort());
    expect(Object.keys(atMM.exact).sort()).toEqual(Object.values(names).sort());
});

it('keeps N exact through native underflow/overflow', () => {
    expect(Number.MIN_VALUE * Number.MIN_VALUE).toBe(0);
    const tiny = calculate(Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, 0, .5, .25);
    expect(pair(valid(tiny.exact.valuationNotionalQuote))).toEqual(['1', String(1n << 2148n)]);
    for (const key of publicKeys) expect(tiny[names[key]].reasons).toEqual(['NUMERIC_UNDERFLOW']);
    expect(Number.MAX_VALUE * 2).toBe(Infinity);
    const huge = calculate(Number.MAX_VALUE, 2, 2, Number.MAX_VALUE, .25, .125);
    expect(huge.exact.valuationNotionalQuote.status).toBe('valid');
    expect(valid(huge.initialMarginQuote)).toBe(Number.MAX_VALUE / 2);
    expect(valid(huge.maintenanceMarginQuote)).toBe(Number.MAX_VALUE / 4);
});

it('retains overflowing exact IM/MM for finite buffers', () => {
    const result = calculate(2, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, 1, .75);
    expect(result.initialMarginQuote.reasons).toEqual(['NUMERIC_OVERFLOW']);
    expect(result.maintenanceMarginQuote.reasons).toEqual(['NUMERIC_OVERFLOW']);
    expect(valid(result.maintenanceBufferQuote)).toBe(-Number.MAX_VALUE / 2);
    expect(valid(result.initialMarginSurplusQuote)).toBe(-Number.MAX_VALUE);
    for (const value of Object.values(result.exact)) expect(value.status).toBe('valid');
});

it('uses exact E/IM/MM when cancellation reveals nonzero H/A', () => {
    const m = Number.MIN_VALUE;
    expect(valid(calculate(1, m, 1, 0, 1, .5).initialMarginSurplusQuote)).toBe(-m);
    expect(valid(calculate(1, .5, 1, m, .75, .5).maintenanceBufferQuote)).toBe(m);
    const next = 1 + 2 ** -52;
    const byIM = calculate(next, next, next, 1 + 2 ** -51, 1, .5);
    expect(valid(byIM.initialMarginSurplusQuote)).toBe(-(2 ** -104));
    expect(1 + 2 ** -51 - valid(byIM.initialMarginQuote)).toBe(0);
    const byMM = calculate(next, next, next, .5 + 2 ** -52, 1, .5);
    expect(valid(byMM.maintenanceBufferQuote)).toBe(-(2 ** -105));
    expect(.5 + 2 ** -52 - valid(byMM.maintenanceMarginQuote)).toBe(0);
});

it('enforces real 4095/4096/4097-bit boundaries without poisoning another metric', () => {
    const m = Number.MIN_VALUE;
    for (const [cashExponent, numeratorBits] of [[873, 4095], [874, 4096]] as const) {
        const result = calculate(m, m, m, 2 ** cashExponent, 2 * m, m);
        const h = numeric(arithmetic.rationalParts(valid(result.exact.maintenanceBufferQuote)));
        expect(h.numerator.toString(2).length).toBe(numeratorBits);
        expect(valid(result.maintenanceBufferQuote)).toBe(2 ** cashExponent);
    }
    const beyond = calculate(m, m, m, 2 ** 875, 2 * m, m);
    expect(beyond.exact.maintenanceBufferQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    expect(beyond.maintenanceBufferQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    expect(beyond.exact.initialMarginSurplusQuote.status).toBe('valid');
    expect(valid(beyond.initialMarginSurplusQuote)).toBe(2 ** 875);
    expect(beyond.initialMarginQuote.reasons).toEqual(['NUMERIC_UNDERFLOW']);
    const onlyBuffer = calculate(m, m, m, Number.MAX_VALUE, 1, m);
    expect(onlyBuffer.maintenanceBufferQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    expect(valid(onlyBuffer.initialMarginSurplusQuote)).toBe(Number.MAX_VALUE);
});

describe('controlled failures and independent publication gates', () => {
    it('propagates N resource refusal to its dependents', () => {
        vi.spyOn(arithmetic, 'multiply').mockReturnValueOnce(resource);
        const result = calculate(2, 8, 8, 6, .25, .125);
        for (const value of Object.values(result.exact)) expect(value.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
        for (const key of publicKeys) expect(result[names[key]].reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    });
    it('preserves IM/MM if S3-05 exact equity is unavailable', () => {
        const h = handle(2, 8, 8, 6, .25, .125);
        const source = pnlEquity.calculatePnlEquity(h);
        vi.spyOn(pnlEquity, 'calculatePnlEquity').mockReturnValue({ ...source, exact: { ...source.exact,
            equityQuote: { status: 'calculation_error', value: null, reasons: ['NUMERIC_RESOURCE_LIMIT'] } } });
        const result = calculateMarginRequirements(h);
        expect(valid(result.initialMarginQuote)).toBe(4);
        expect(valid(result.maintenanceMarginQuote)).toBe(2);
        expect(result.maintenanceBufferQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
        expect(result.initialMarginSurplusQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    });
    for (const call of [1, 2, 3, 4, 5, 6]) {
        it(`does not use publication ${call} in any exact computation`, () => {
            const original = arithmetic.publish;
            let calls = 0;
            const spy = vi.spyOn(arithmetic, 'publish').mockImplementation(value => {
                calls += 1;
                return calls === call ? resource : original(value);
            });
            const result = calculate(2, 8, 8, 6, .25, .125);
            expect(spy).toHaveBeenCalledTimes(6); // PnL,E,IM,MM,H,A; N is not published.
            for (const exact of Object.values(result.exact)) expect(exact.status).toBe('valid');
            for (const [index, key] of publicKeys.entries()) {
                if (index + 3 === call) expect(result[names[key]].reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
                else expect(valid(result[names[key]])).toBe([4, 2, 4, 2][index]);
            }
        });
    }
});

it('rejects forged/revoked/wrong-kind handles without traps or partial results', () => {
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps += 1; throw Error('get'); }, ownKeys() { traps += 1; throw Error('keys'); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const real = inputHandle();
    const wrongKind = contextHandle();
    const decode = vi.spyOn(arithmetic, 'fromBinary64');
    for (const raw of [undefined, null, 1, 1n, Symbol('bad'), {}, baseline(), proxy, revoked.proxy,
        new Proxy(real, {}), { ...real }, Object.create(real), wrongKind]) {
        const result = calculateMarginRequirements(raw as PreparedMarginInput);
        for (const exact of Object.values(result.exact)) expect(exact.reasons).toEqual(['CALCULATION_FAILED']);
        for (const key of publicKeys) expect(result[names[key]]).toEqual({ status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] });
    }
    expect(traps).toBe(0);
    expect(decode).not.toHaveBeenCalled();
});

it('requires explicit valid rates and supported scope', () => {
    for (const patch of [{ initialMarginRate: 0 }, { maintenanceMarginRate: 0 }, { initialMarginRate: 1.01 },
        { initialMarginRate: .1, maintenanceMarginRate: .1 }, { initialMarginRate: .1, maintenanceMarginRate: .2 },
        { modelVersion: '2' }, { modelId: 'venue-specific' }, { tiersPolicy: 'tiered' }]) {
        const input = baseline(); Object.assign(input.policy, patch);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
    }
    for (const field of ['initialMarginRate', 'maintenanceMarginRate']) {
        const input = baseline(); Reflect.deleteProperty(input.policy, field);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
    }
    for (const patch of [{ marginMode: 'cross' }, { side: 'unknown' }, { qtyBase: 0 }, { netCashQuote: -1 }]) {
        const input = baseline(); Object.assign(input.snapshot, patch);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
    }
});

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const cash = fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const rate = fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true, noDefaultInfinity: true });
const rates = fc.tuple(rate, rate).filter(([a, b]) => a !== b).map(([a, b]) => [Math.max(a, b), Math.min(a, b)] as const);
it('checks exact positivity, identities, resource policy and independent publication for 1000 binary64 inputs', () => {
    fc.assert(fc.property(positive, positive, positive, cash, rates, fc.constantFrom('LONG' as const, 'SHORT' as const), (q, e, p, c, [i, m], side) => {
        const h = handle(q, e, p, c, i, m, side);
        const result = calculateMarginRequirements(h);
        const n = valid(result.exact.valuationNotionalQuote), im = valid(result.exact.initialMarginQuote), mm = valid(result.exact.maintenanceMarginQuote);
        expect(numeric(arithmetic.compare(n, exactNumber(0)))).toBe(1);
        expect(numeric(arithmetic.compare(mm, exactNumber(0)))).toBe(1);
        expect(numeric(arithmetic.compare(im, mm))).toBe(1);
        const equity = valid(pnlEquity.calculatePnlEquity(h).exact.equityQuote);
        for (const [margin, difference] of [[mm, result.exact.maintenanceBufferQuote], [im, result.exact.initialMarginSurplusQuote]] as const) {
            const expected = arithmetic.subtract(equity, margin);
            if (expected.ok) expect(pair(valid(difference))).toEqual(pair(expected.value));
            else expect(difference.reasons).toEqual([expected.error.code]);
        }
        if (result.exact.maintenanceBufferQuote.status === 'valid' && result.exact.initialMarginSurplusQuote.status === 'valid') {
            expect(pair(numeric(arithmetic.subtract(result.exact.maintenanceBufferQuote.value, result.exact.initialMarginSurplusQuote.value))))
                .toEqual(pair(numeric(arithmetic.subtract(im, mm))));
        }
        for (const key of publicKeys) {
            const exact = result.exact[names[key]], published = result[names[key]];
            if (exact.status !== 'valid') { expect(published.reasons).toEqual(exact.reasons); continue; }
            const before = pair(exact.value), independent = arithmetic.publish(exact.value);
            if (independent.ok) expect(valid(published)).toBe(independent.value);
            else expect(published.reasons).toEqual([independent.error.code]);
            expect(pair(exact.value)).toEqual(before);
            if (published.status === 'valid') {
                expect(Number.isFinite(published.value)).toBe(true);
                expect(Object.is(published.value, -0)).toBe(false);
                if (before[0] !== '0') expect(published.value).not.toBe(0);
            }
        }
    }), { seed: 306, numRuns: 1000 });
}, 30_000);

it('increasing either rate strictly increases its exact requirement', () => {
    fc.assert(fc.property(positive, positive, fc.uniqueArray(rate, { minLength: 3, maxLength: 3 }), (q, p, values) => {
        const [low, middle, high] = [...values].sort((a, b) => a - b) as [number, number, number];
        const a = calculate(q, p, p, 0, middle, low), b = calculate(q, p, p, 0, high, low), c = calculate(q, p, p, 0, high, middle);
        expect(numeric(arithmetic.compare(valid(a.exact.initialMarginQuote), valid(b.exact.initialMarginQuote)))).toBe(-1);
        expect(numeric(arithmetic.compare(valid(b.exact.maintenanceMarginQuote), valid(c.exact.maintenanceMarginQuote)))).toBe(-1);
    }), { seed: 5306, numRuns: 300 });
}, 30_000);

it('increasing equity through cash strictly increases exact H/A with unchanged IM/MM', () => {
    fc.assert(fc.property(positive, positive, positive, cash, cash, (q, e, p, c1, c2) => {
        const low = Math.min(c1, c2), high = Math.max(c1, c2);
        const a = calculate(q, e, p, low, .5, .25), b = calculate(q, e, p, high, .5, .25);
        for (const key of ['IM', 'MM'] as const) expect(pair(valid(a.exact[names[key]]))).toEqual(pair(valid(b.exact[names[key]])));
        for (const key of ['H', 'A'] as const) expect(numeric(arithmetic.compare(valid(a.exact[names[key]]), valid(b.exact[names[key]])))).toBe(low === high ? 0 : -1);
    }), { seed: 6306, numRuns: 300 });
}, 30_000);

it('matches existing metric contracts and keeps exact results separate', () => {
    expectTypeOf<MarginRequirementsCalculation['initialMarginQuote']>().toEqualTypeOf<MarginAssessmentV1['metrics']['initialMarginQuote']>();
    expectTypeOf<MarginRequirementsCalculation['maintenanceBufferQuote']>().toEqualTypeOf<Result<FiniteNumber>>();
    function compileOnly(): void {
        // @ts-expect-error A schema-typed object is not an authenticated handle.
        calculateMarginRequirements(baseline());
        // @ts-expect-error Exact internal results cannot enter published fields.
        const value: Result<FiniteNumber> = calculateMarginRequirements(inputHandle()).exact.initialMarginQuote;
        void value;
    }
    void compileOnly;
});

it('has no unchecked casts, number arithmetic or forbidden dependencies', () => {
    const source = readFileSync(new URL('margin-requirements.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('margin-requirements.ts', source, ts.ScriptTarget.Latest, true);
    const allowed = new Set(['../../types/margin-assessment.js', './arithmetic.js', './canonicalization.js', './pnl-equity.js', './validation.js']);
    const forbidden = new Set(['process', 'Date', 'fetch', 'require', 'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket', 'BigInt', 'Number', 'Math']);
    const ops = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskAsteriskToken]);
    function inspect(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
            if (ts.isStringLiteral(node.moduleSpecifier)) expect(allowed.has(node.moduleSpecifier.text)).toBe(true);
            if (node.moduleSpecifier.getText(ast).includes('/types/')) expect(node.importClause?.isTypeOnly).toBe(true);
        }
        if (ts.isIdentifier(node)) expect(forbidden.has(node.text)).toBe(false);
        if (ts.isBinaryExpression(node)) expect(ops.has(node.operatorToken.kind)).toBe(false);
        if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) expect.fail('No financial type assertions');
        ts.forEachChild(node, inspect);
    }
    inspect(ast);
});
