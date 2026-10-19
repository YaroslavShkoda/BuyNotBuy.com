import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import ts from 'typescript-5';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { FiniteNumber, MarginAssessmentV1, Result } from '../../types/margin-assessment.js';
import type { ExactRational } from './arithmetic.js';
import * as arithmetic from './arithmetic.js';
import { type PreparedMarginInput, prepareMarginInputJson } from './canonicalization.js';
import { calculateMarginRequirements } from './margin-requirements.js';
import { calculatePnlEquity } from './pnl-equity.js';
import { calculateRatiosLeverage, type RatiosLeverageCalculation } from './ratios-leverage.js';
import { baseline, contextHandle, inputHandle } from './test-support/identity-fixtures.js';

type Pair = [string, string];
interface ExactVector { status: string; parts?: Pair; reasons: string[] }
interface PublishedVector { status: string; bits: string | null; reasons: string[] }
interface Vector {
    name: string; side: 'LONG' | 'SHORT'; inputs: Record<'q' | 'e' | 'p' | 'cash' | 'i' | 'm', string>;
    entryNotional: Pair; equity: { parts: Pair; published: PublishedVector };
    metrics: Record<'R' | 'L' | 'LE', { exact: ExactVector; published: PublishedVector }>;
    doubleRoundingWitnesses: string[];
}
const corpus: { cases: Vector[] } = JSON.parse(readFileSync(new URL('test-support/ratios-leverage-corpus.json', import.meta.url), 'utf8'));
const names = { R: 'maintenanceRequirementToEquity', L: 'effectiveGrossLeverage', LE: 'entryCollateralLeverage' } as const;
function valid<T>(r: Result<T>): T { if (r.status !== 'valid') throw Error(r.reasons.join(',')); return r.value; }
function numeric<T>(r: arithmetic.NumericResult<T>): T { if (!r.ok) throw Error(r.error.code); return r.value; }
const exactNumber = (n: number) => numeric(arithmetic.fromBinary64(n));
function pair(value: ExactRational): Pair { const p = numeric(arithmetic.rationalParts(value)); return [String(p.numerator), String(p.denominator)]; }
function number(raw: string): number { const v = new DataView(new ArrayBuffer(8)); v.setBigUint64(0, BigInt(`0x${raw}`)); return v.getFloat64(0); }
function bits(n: number): string { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, n); return v.getBigUint64(0).toString(16).padStart(16, '0'); }
function handle(q: number, e: number, p: number, cash: number, i = .5, m = .25, side: 'LONG' | 'SHORT' = 'LONG'): PreparedMarginInput {
    const input = baseline();
    Object.assign(input.snapshot, { qtyBase: q, entryPriceQuotePerBase: e, netCashQuote: cash, side });
    input.snapshot.valuation.priceQuotePerBase = p;
    Object.assign(input.policy, { initialMarginRate: i, maintenanceMarginRate: m });
    return inputHandle(JSON.stringify(input));
}
const calculate = (q: number, e: number, p: number, cash: number, i = .5, m = .25, side: 'LONG' | 'SHORT' = 'LONG') => calculateRatiosLeverage(handle(q, e, p, cash, i, m, side));
const resource = { ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT', cause: 'resource_limit' } } as const;
const domain = (reason: string) => ({ status: 'not_applicable', value: null, reasons: [reason] });
afterEach(() => vi.restoreAllMocks());

describe('independent Python fractions: exact outcomes, domains, resource policy and publication', () => {
    it.each(corpus.cases)('$name', row => {
        const v = row.inputs;
        const actual = calculate(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), row.side);
        expect(pair(valid(actual.exact.entryNotionalQuote))).toEqual(row.entryNotional);
        for (const key of Object.keys(names) as (keyof typeof names)[]) {
            const expected = row.metrics[key], exact = actual.exact[names[key]], published = actual[names[key]];
            expect(exact.status).toBe(expected.exact.status);
            expect(exact.reasons).toEqual(expected.exact.reasons);
            if (expected.exact.status === 'valid') expect(pair(valid(exact))).toEqual(expected.exact.parts);
            else expect(exact.value).toBeNull();
            expect({ status: published.status, bits: published.value === null ? null : bits(published.value), reasons: published.reasons }).toEqual(expected.published);
            if (published.status === 'valid') {
                expect(Number.isFinite(published.value)).toBe(true); expect(Object.is(published.value, -0)).toBe(false);
                expect(published.value).toBeGreaterThan(0);
            }
        }
    });
});

it('uses dimensionless MM/E, N/E and exact entry notional/C', () => {
    const r = calculate(2, 8, 8, 4, .25, .125);
    expect(valid(r.maintenanceRequirementToEquity)).toBe(.5);
    expect(valid(r.effectiveGrossLeverage)).toBe(4);
    expect(valid(r.entryCollateralLeverage)).toBe(4);
    expect(Object.keys(r).sort()).toEqual(['exact', ...Object.values(names)].sort());
});

it('guards E=0, E<0 and C=0 before division; entry leverage ignores E sign', () => {
    const divide = vi.spyOn(arithmetic, 'divide');
    const empty = calculate(1, 1, 1, 0);
    expect(empty.maintenanceRequirementToEquity).toEqual(domain('NON_POSITIVE_EQUITY'));
    expect(empty.effectiveGrossLeverage).toEqual(domain('NON_POSITIVE_EQUITY'));
    expect(empty.entryCollateralLeverage).toEqual(domain('ZERO_COLLATERAL'));
    expect(divide).not.toHaveBeenCalled();
    for (const [cash, entryExpected] of [[4, 1.5], [1, 6]] as const) {
        divide.mockClear();
        const result = calculate(2, 3, 1, cash);
        expect(result.maintenanceRequirementToEquity).toEqual(domain('NON_POSITIVE_EQUITY'));
        expect(result.effectiveGrossLeverage).toEqual(domain('NON_POSITIVE_EQUITY'));
        expect(valid(result.entryCollateralLeverage)).toBe(entryExpected);
        expect(divide).toHaveBeenCalledTimes(1);
    }
    divide.mockClear();
    const noCash = calculate(2, 1, 2, 0);
    expect(valid(noCash.maintenanceRequirementToEquity)).toBe(.5);
    expect(valid(noCash.effectiveGrossLeverage)).toBe(2);
    expect(noCash.entryCollateralLeverage).toEqual(domain('ZERO_COLLATERAL'));
    expect(divide).toHaveBeenCalledTimes(2);
});

it('uses positive exact equity even when its publication underflows or overflows', () => {
    const u = Number.MIN_VALUE;
    const tinyHandle = handle(.5, 2 * u, u, u, 1, .5);
    expect(calculatePnlEquity(tinyHandle).equityQuote.reasons).toEqual(['NUMERIC_UNDERFLOW']);
    const tiny = calculateRatiosLeverage(tinyHandle);
    expect(valid(tiny.maintenanceRequirementToEquity)).toBe(.5);
    expect(valid(tiny.effectiveGrossLeverage)).toBe(1);
    expect(valid(tiny.entryCollateralLeverage)).toBe(1);
    const bigHandle = handle(2, u, Number.MAX_VALUE, Number.MAX_VALUE, 1, .75);
    expect(calculatePnlEquity(bigHandle).equityQuote.reasons).toEqual(['NUMERIC_OVERFLOW']);
    const big = calculateRatiosLeverage(bigHandle);
    expect(valid(big.maintenanceRequirementToEquity)).toBe(.5);
    expect(valid(big.effectiveGrossLeverage)).toBe(2 / 3);
    expect(big.entryCollateralLeverage.reasons).toEqual(['NUMERIC_UNDERFLOW']);
});

it('refuses huge finite exact quotients at publication without publishing Infinity', () => {
    const result = calculate(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MIN_VALUE, 1, .5);
    for (const key of Object.values(names)) {
        expect(result.exact[key].status).toBe('valid');
        expect(result[key]).toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_OVERFLOW'] });
    }
});

it('keeps real ratio resource refusal and underflow local to each metric', () => {
    const u = Number.MIN_VALUE;
    const result = calculate(u, u, u, Number.MAX_VALUE, 2 * u, u);
    expect(result.exact.maintenanceRequirementToEquity.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    expect(result.maintenanceRequirementToEquity.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    expect(result.exact.effectiveGrossLeverage.status).toBe('valid');
    expect(result.effectiveGrossLeverage.reasons).toEqual(['NUMERIC_UNDERFLOW']);
    expect(result.exact.entryCollateralLeverage.status).toBe('valid');
    const smallRatio = calculate(1, 1, 1, 3, 2 * u, u);
    expect(smallRatio.maintenanceRequirementToEquity.reasons).toEqual(['NUMERIC_UNDERFLOW']);
    expect(valid(smallRatio.effectiveGrossLeverage)).toBe(1 / 3);
    expect(valid(smallRatio.entryCollateralLeverage)).toBe(1 / 3);
});

it('retains entry notional across native product overflow/underflow', () => {
    const max = Number.MAX_VALUE, u = Number.MIN_VALUE;
    expect(max * max).toBe(Infinity);
    expect(valid(calculate(max, max, max, max, 1, .5).entryCollateralLeverage)).toBe(max);
    expect(u * u).toBe(0);
    expect(valid(calculate(u, u, u, u, 1, .5).entryCollateralLeverage)).toBe(u);
});

it('pins a corpus counterexample to dividing already published MM and E', () => {
    const row = corpus.cases.find(v => v.doubleRoundingWitnesses.includes('R'));
    expect(row).toBeDefined();
    if (!row) throw Error('missing double rounding witness');
    const v = row.inputs, h = handle(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), row.side);
    const actual = calculateRatiosLeverage(h);
    const roundedDivision = valid(calculateMarginRequirements(h).maintenanceMarginQuote) / valid(calculatePnlEquity(h).equityQuote);
    expect(bits(valid(actual.maintenanceRequirementToEquity))).not.toBe(bits(roundedDivision));
});

describe('independent controlled failures', () => {
    for (const call of [1, 2, 3]) it(`division ${call} resource failure affects only its metric`, () => {
        const original = arithmetic.divide; let count = 0;
        vi.spyOn(arithmetic, 'divide').mockImplementation((a, b) => ++count === call ? resource : original(a, b));
        const result = calculate(2, 8, 8, 4, .25, .125);
        for (const [index, key] of Object.values(names).entries()) {
            if (index + 1 === call) expect(result[key].reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
            else expect(valid(result[key])).toBe([.5, 4, 4][index]);
        }
    });
    it('comparison failure is controlled and does not turn into division or valid zero', () => {
        vi.spyOn(arithmetic, 'compare').mockReturnValueOnce(resource);
        const divide = vi.spyOn(arithmetic, 'divide');
        const result = calculate(2, 8, 8, 4, .25, .125);
        expect(result.maintenanceRequirementToEquity.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
        expect(valid(result.effectiveGrossLeverage)).toBe(4);
        expect(valid(result.entryCollateralLeverage)).toBe(4);
        expect(divide).toHaveBeenCalledTimes(2);
    });
    for (const call of Array.from({ length: 11 }, (_, index) => index + 1)) it(`publication ${call} never supplies exact operands`, () => {
        const original = arithmetic.publish; let count = 0;
        const spy = vi.spyOn(arithmetic, 'publish').mockImplementation(v => ++count === call ? resource : original(v));
        const result = calculate(2, 8, 8, 4, .25, .125);
        expect(spy).toHaveBeenCalledTimes(11); // Eight inherited gate calls, then R/L/LE.
        for (const [index, key] of Object.values(names).entries()) {
            expect(result.exact[key].status).toBe('valid');
            if (index + 9 === call) expect(result[key].reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
            else expect(valid(result[key])).toBe([.5, 4, 4][index]);
        }
    });
});

it('rejects forged/revoked/wrong-kind handles before decoding or getters', () => {
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps++; throw Error('get'); }, ownKeys() { traps++; throw Error('keys'); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const real = inputHandle(), wrongKind = contextHandle();
    const getter = { get snapshot() { traps++; throw Error('snapshot'); } };
    const decode = vi.spyOn(arithmetic, 'fromBinary64');
    for (const raw of [undefined, null, NaN, Infinity, 0, 1n, Symbol('bad'), {}, baseline(), getter, hostile, revoked.proxy,
        { ...real }, new Proxy(real, {}), Object.create(real), wrongKind]) {
        const r = calculateRatiosLeverage(raw as PreparedMarginInput);
        for (const exact of Object.values(r.exact)) expect(exact).toEqual({ status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] });
        for (const key of Object.values(names)) expect(r[key]).toEqual({ status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] });
    }
    expect(traps).toBe(0); expect(decode).not.toHaveBeenCalled();
});

it('does not invent missing financial parameters or admit unsupported scope', () => {
    for (const field of ['qtyBase', 'entryPriceQuotePerBase', 'netCashQuote', 'side']) {
        const input = baseline(); Reflect.deleteProperty(input.snapshot, field);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
    }
    for (const field of ['initialMarginRate', 'maintenanceMarginRate']) {
        const input = baseline(); Reflect.deleteProperty(input.policy, field);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
    }
    for (const patch of [{ marginMode: 'cross' }, { qtyBase: 0 }, { netCashQuote: -1 }, { side: 'unknown' }]) {
        const input = baseline(); Object.assign(input.snapshot, patch);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
    }
});

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const cash = fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const rate = fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true, noDefaultInfinity: true });
const rates = fc.tuple(rate, rate).filter(([a, b]) => a !== b).map(([a, b]) => [Math.max(a, b), Math.min(a, b)] as const);
it('checks positive domains, exact R/L=m, publication invariants and preserved exact outcomes for 1000 inputs', () => {
    fc.assert(fc.property(positive, positive, positive, cash, rates, fc.constantFrom('LONG' as const, 'SHORT' as const), (q, e, p, c, [i, m], side) => {
        const h = handle(q, e, p, c, i, m, side), r = calculateRatiosLeverage(h);
        const eq = valid(calculatePnlEquity(h).exact.equityQuote);
        const sign = numeric(arithmetic.compare(eq, exactNumber(0)));
        if (sign <= 0) {
            expect(r.maintenanceRequirementToEquity).toEqual(domain('NON_POSITIVE_EQUITY'));
            expect(r.effectiveGrossLeverage).toEqual(domain('NON_POSITIVE_EQUITY'));
        } else {
            for (const key of ['maintenanceRequirementToEquity', 'effectiveGrossLeverage'] as const) {
                const exact = r.exact[key];
                if (exact.status === 'valid') expect(numeric(arithmetic.compare(exact.value, exactNumber(0)))).toBe(1);
                else expect(exact.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
            }
            if (r.exact.maintenanceRequirementToEquity.status === 'valid' && r.exact.effectiveGrossLeverage.status === 'valid') {
                expect(pair(numeric(arithmetic.divide(r.exact.maintenanceRequirementToEquity.value, r.exact.effectiveGrossLeverage.value)))).toEqual(pair(exactNumber(m)));
            }
        }
        if (c === 0) expect(r.entryCollateralLeverage).toEqual(domain('ZERO_COLLATERAL'));
        else expect(numeric(arithmetic.compare(valid(r.exact.entryCollateralLeverage), exactNumber(0)))).toBe(1);
        for (const key of Object.values(names)) {
            const exact = r.exact[key], published = r[key];
            if (exact.status !== 'valid') { expect(published).toEqual(exact); continue; }
            const before = pair(exact.value), independent = arithmetic.publish(exact.value);
            if (independent.ok) expect(valid(published)).toBe(independent.value);
            else expect(published.reasons).toEqual([independent.error.code]);
            expect(pair(exact.value)).toEqual(before);
            if (published.status === 'valid') {
                expect(Number.isFinite(published.value)).toBe(true); expect(Object.is(published.value, -0)).toBe(false); expect(published.value).toBeGreaterThan(0);
            }
        }
    }), { seed: 307, numRuns: 1000 });
}, 30_000);

it('increasing E/C strictly decreases all exact quotients for fixed notionals and MM', () => {
    fc.assert(fc.property(positive, positive, positive, positive, (q, p, c1, c2) => {
        const low = Math.min(c1, c2), high = Math.max(c1, c2);
        const a = calculate(q, p, p, low), b = calculate(q, p, p, high);
        for (const key of Object.values(names)) {
            expect(numeric(arithmetic.compare(valid(a.exact[key]), valid(b.exact[key])))).toBe(low === high ? 0 : 1);
        }
    }), { seed: 5307, numRuns: 500 });
}, 30_000);

it('matches all existing ratio/leverage fields without trusting schema-typed objects or issuing brands', () => {
    expectTypeOf<RatiosLeverageCalculation['maintenanceRequirementToEquity']>().toEqualTypeOf<MarginAssessmentV1['metrics']['maintenanceRequirementToEquity']>();
    expectTypeOf<RatiosLeverageCalculation['effectiveGrossLeverage']>().toEqualTypeOf<MarginAssessmentV1['metrics']['effectiveGrossLeverage']>();
    expectTypeOf<RatiosLeverageCalculation['entryCollateralLeverage']>().toEqualTypeOf<Result<FiniteNumber>>();
    function compileOnly(): void {
        // @ts-expect-error A schema-typed object is not an authenticated handle.
        calculateRatiosLeverage(baseline());
        // @ts-expect-error Exact results are not published finite values.
        const r: Result<FiniteNumber> = calculateRatiosLeverage(inputHandle()).exact.effectiveGrossLeverage;
        void r;
    }
    void compileOnly;
});

it('limits production imports and arithmetic to the approved foundations', () => {
    const source = readFileSync(new URL('ratios-leverage.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('ratios-leverage.ts', source, ts.ScriptTarget.Latest, true);
    const allowed = new Set(['../../types/margin-assessment.js', './arithmetic.js', './canonicalization.js', './margin-requirements.js', './pnl-equity.js', './validation.js']);
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
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) expect.fail('No unchecked financial assertions');
        ts.forEachChild(node, inspect);
    }
    inspect(ast);
});
