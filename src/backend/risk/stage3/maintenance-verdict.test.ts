import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import ts from 'typescript-5';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { MaintenanceVerdict, MarginAssessmentV1, Result } from '../../types/margin-assessment.js';
import type { ExactRational } from './arithmetic.js';
import * as arithmetic from './arithmetic.js';
import { type PreparedMarginInput, prepareMarginInputJson, readCanonicalMarginInput } from './canonicalization.js';
import { calculateMaintenanceVerdict, type MaintenanceCalculation } from './maintenance-verdict.js';
import * as margins from './margin-requirements.js';
import * as pnl from './pnl-equity.js';
import { baseline, contextHandle, inputHandle } from './test-support/identity-fixtures.js';

type Mode = 'lt' | 'lte';
type Pair = [string, string];
interface SourceVector {
    exact: { status: string; parts?: Pair; reasons: string[] };
    published: { status: string; bits: string | null; reasons: string[] };
}
interface Vector {
    name: string; side: 'LONG' | 'SHORT'; inputs: Record<'q' | 'e' | 'p' | 'cash' | 'i' | 'm', string>;
    sources: Record<'E' | 'MM' | 'H', SourceVector>;
    verdicts: Record<Mode, { exact: Result<MaintenanceVerdict>; public: Result<MaintenanceVerdict> }>;
}
const corpus: { cases: Vector[] } = JSON.parse(readFileSync(new URL('test-support/maintenance-verdict-corpus.json', import.meta.url), 'utf8'));
const exactKeys = { E: 'equityQuote', MM: 'maintenanceMarginQuote', H: 'maintenanceBufferQuote' } as const;
function valid<T>(r: Result<T>): T { if (r.status !== 'valid') throw Error(r.reasons.join(',')); return r.value; }
function numeric<T>(r: arithmetic.NumericResult<T>): T { if (!r.ok) throw Error(r.error.code); return r.value; }
function pair(v: ExactRational): Pair { const p = numeric(arithmetic.rationalParts(v)); return [String(p.numerator), String(p.denominator)]; }
function number(raw: string): number { const v = new DataView(new ArrayBuffer(8)); v.setBigUint64(0, BigInt(`0x${raw}`)); return v.getFloat64(0); }
function bits(n: number): string { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, n); return v.getBigUint64(0).toString(16).padStart(16, '0'); }
function handle(q: number, e: number, p: number, cash: number, i: number, m: number, mode: Mode, side: 'LONG' | 'SHORT' = 'LONG'): PreparedMarginInput {
    const input = baseline();
    Object.assign(input.snapshot, { qtyBase: q, entryPriceQuotePerBase: e, netCashQuote: cash, side });
    input.snapshot.valuation.priceQuotePerBase = p;
    Object.assign(input.policy, { initialMarginRate: i, maintenanceMarginRate: m, comparison: mode });
    return inputHandle(JSON.stringify(input));
}
const calculate = (q: number, e: number, p: number, cash: number, i: number, m: number, mode: Mode, side: 'LONG' | 'SHORT' = 'LONG') =>
    calculateMaintenanceVerdict(handle(q, e, p, cash, i, m, mode, side));
const resource = { ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT', cause: 'resource_limit' } } as const;
const resourceResult = { status: 'calculation_error', value: null, reasons: ['NUMERIC_RESOURCE_LIMIT'] } as const;
afterEach(() => vi.restoreAllMocks());

describe('independent Python Fraction corpus: both explicit policies, exact sources and eligibility', () => {
    it.each(corpus.cases)('$name', row => {
        const v = row.inputs;
        for (const mode of ['lt', 'lte'] as const) {
            const h = handle(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), mode, row.side);
            const actual = calculateMaintenanceVerdict(h);
            expect(actual.exact.maintenance).toEqual(row.verdicts[mode].exact);
            expect(actual.maintenance).toEqual(row.verdicts[mode].public);
            const sources = { E: pnl.calculatePnlEquity(h).equityQuote, MM: margins.calculateMarginRequirements(h).maintenanceMarginQuote,
                H: margins.calculateMarginRequirements(h).maintenanceBufferQuote };
            for (const key of Object.keys(exactKeys) as (keyof typeof exactKeys)[]) {
                const e = row.sources[key], exact = actual.exact[exactKeys[key]], published = sources[key];
                expect(exact.status).toBe(e.exact.status); expect(exact.reasons).toEqual(e.exact.reasons);
                if (exact.status === 'valid') expect(pair(exact.value)).toEqual(e.exact.parts); else expect(exact.value).toBeNull();
                expect({ status: published.status, bits: published.value === null ? null : bits(published.value), reasons: published.reasons }).toEqual(e.published);
            }
        }
    });
});

it('implements the complete relation/state/strict/non-strict table', () => {
    for (const [cash, relation, state, strict, nonStrict] of [
        [6, 'positive', 'above_threshold', false, false], [2, 'zero', 'at_threshold', false, true],
        [1, 'negative', 'below_threshold', true, true],
    ] as const) {
        for (const mode of ['lt', 'lte'] as const) {
            const a = calculate(2, 8, 8, cash, .25, .125, mode);
            expect(valid(a.maintenance)).toEqual({ exactRelation: relation, state, comparison: mode, detected: mode === 'lt' ? strict : nonStrict });
        }
    }
    for (const cash of [0, 1]) expect(valid(calculate(2, 9, 8, cash, .25, .125, 'lt').maintenance).detected).toBe(true);
});

it('keeps exact signs when E/MM publish identically and H rounds to zero', () => {
    const u = Number.MIN_VALUE;
    for (const [price, relation, detected] of [[3 * u, 'positive', false], [5 * u, 'negative', true]] as const) {
        const h = handle(.5, price, price, u, 1, .5, 'lt');
        const e = pnl.calculatePnlEquity(h), mm = margins.calculateMarginRequirements(h), a = calculateMaintenanceVerdict(h);
        expect(bits(valid(e.equityQuote))).toBe(bits(valid(mm.maintenanceMarginQuote)));
        expect(mm.maintenanceBufferQuote.reasons).toEqual(['NUMERIC_UNDERFLOW']);
        expect(valid(a.maintenance).exactRelation).toBe(relation); expect(valid(a.maintenance).detected).toBe(detected);
        expect(valid(a.exact.maintenance)).toEqual(valid(a.maintenance));
    }
});

it('does not require H publication, including overflow with finite E/MM', () => {
    const h = handle(2, Number.MAX_VALUE, Number.MAX_VALUE / 2, 0, 1, .5, 'lt');
    const source = margins.calculateMarginRequirements(h), a = calculateMaintenanceVerdict(h);
    expect(pnl.calculatePnlEquity(h).equityQuote.status).toBe('valid'); expect(source.maintenanceMarginQuote.status).toBe('valid');
    expect(source.maintenanceBufferQuote.reasons).toEqual(['NUMERIC_OVERFLOW']);
    expect(valid(a.maintenance)).toEqual({ exactRelation: 'negative', comparison: 'lt', state: 'below_threshold', detected: true });
});

it('compares E/MM without requiring the exact H component to fit', () => {
    const u = Number.MIN_VALUE, h = handle(u, u, u, Number.MAX_VALUE, 2 * u, u, 'lt');
    const a = calculateMaintenanceVerdict(h);
    expect(a.exact.maintenanceBufferQuote).toEqual(resourceResult);
    expect(valid(a.exact.maintenance).exactRelation).toBe('positive');
    expect(a.maintenance.reasons).toEqual(['NUMERIC_UNDERFLOW']); // MM prerequisite, not H resource error.
});

it('requires E/MM publication despite a successful exact comparison', () => {
    for (const name of ['E-underflow-MM-finite-LONG', 'E-overflow-MM-finite-LONG', 'MM-overflow-E-finite-LONG',
        'MM-underflow-E-finite-LONG', 'E-MM-overflow-LONG']) {
        const row = corpus.cases.find(r => r.name === name); if (!row) throw Error(name);
        const v = row.inputs, a = calculate(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), 'lt', row.side);
        expect(a.exact.maintenance.status).toBe('valid'); expect(a.maintenance.status).toBe('calculation_error'); expect(a.maintenance.value).toBeNull();
        expect(a.maintenance).toEqual(row.verdicts.lt.public);
    }
});

it('recognizes a difference lost in published E/MM, and a rounded JS difference', () => {
    const next = 1 + 2 ** -52, h = handle(next, next, next, .5 + 2 ** -52, 1, .5, 'lt');
    expect(valid(pnl.calculatePnlEquity(h).equityQuote)).toBe(valid(margins.calculateMarginRequirements(h).maintenanceMarginQuote));
    expect(valid(calculateMaintenanceVerdict(h).maintenance).detected).toBe(true);
    const decimal = handle(1, 1, 1, 1, .2, .1, 'lt'), source = margins.calculateMarginRequirements(decimal);
    const native = numeric(arithmetic.fromBinary64(1 - valid(source.maintenanceMarginQuote)));
    expect(pair(native)).not.toEqual(pair(valid(source.exact.maintenanceBufferQuote)));
    expect(valid(calculateMaintenanceVerdict(decimal).maintenance).state).toBe('above_threshold');
});

describe('controlled failures and publication prerequisites', () => {
    it('propagates exact comparison failure without publishing a false safe verdict', () => {
        vi.spyOn(arithmetic, 'compare').mockReturnValueOnce(resource);
        const a = calculate(2, 8, 8, 6, .25, .125, 'lt');
        expect(a.exact.maintenance).toEqual(resourceResult); expect(a.maintenance).toEqual(resourceResult);
    });
    for (const call of [1, 2, 3, 4, 5, 6, 7, 8]) it(`publication ${call} only blocks its explicit prerequisites`, () => {
        const original = arithmetic.publish; let calls = 0;
        vi.spyOn(arithmetic, 'publish').mockImplementation(v => ++calls === call ? resource : original(v));
        const a = calculate(2, 8, 8, 2, .25, .125, 'lte');
        expect(calls).toBe(8); // Direct PnL/E, then S3-06's PnL/E/IM/MM/H/A.
        expect(valid(a.exact.maintenance).detected).toBe(true);
        if (call === 2 || call === 6) expect(a.maintenance).toEqual(resourceResult);
        else expect(valid(a.maintenance).detected).toBe(true);
    });
    it('aggregates prerequisite reasons in E/MM order, deduplicates, and excludes H', () => {
        const original = arithmetic.publish; let count = 0;
        vi.spyOn(arithmetic, 'publish').mockImplementation(v => {
            count++;
            if (count === 2) return { ok: false, error: { code: 'NUMERIC_UNDERFLOW', cause: 'underflow' } };
            if (count === 6) return { ok: false, error: { code: 'NUMERIC_OVERFLOW', cause: 'overflow' } };
            if (count === 7) return resource;
            return original(v);
        });
        const a = calculate(2, 8, 8, 2, .25, .125, 'lt');
        expect(a.maintenance).toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_UNDERFLOW', 'NUMERIC_OVERFLOW'] });
    });
    it('ignores unavailable exact H when exact E/MM and their publications succeed', () => {
        const original = margins.calculateMarginRequirements;
        vi.spyOn(margins, 'calculateMarginRequirements').mockImplementation(h => {
            const r = original(h); return { ...r, exact: { ...r.exact, maintenanceBufferQuote: resourceResult }, maintenanceBufferQuote: resourceResult };
        });
        const a = calculate(2, 8, 8, 2, .25, .125, 'lte');
        expect(a.exact.maintenanceBufferQuote).toEqual(resourceResult); expect(valid(a.maintenance).detected).toBe(true);
    });
    it('propagates unavailable exact E even if an injected published E appears valid', () => {
        const original = pnl.calculatePnlEquity;
        vi.spyOn(pnl, 'calculatePnlEquity').mockImplementation(h => {
            const r = original(h); return { ...r, exact: { ...r.exact, equityQuote: resourceResult } };
        });
        const a = calculate(2, 8, 8, 2, .25, .125, 'lt');
        expect(a.exact.maintenance).toEqual(resourceResult); expect(a.maintenance).toEqual(resourceResult);
    });
    it('propagates unavailable exact MM, without requiring a subtraction', () => {
        const original = margins.calculateMarginRequirements;
        vi.spyOn(margins, 'calculateMarginRequirements').mockImplementation(h => {
            const r = original(h); return { ...r, exact: { ...r.exact, maintenanceMarginQuote: resourceResult } };
        });
        const a = calculate(2, 8, 8, 2, .25, .125, 'lt');
        expect(a.exact.maintenance).toEqual(resourceResult); expect(a.maintenance).toEqual(resourceResult);
    });
});

it('rejects forged, revoked, wrong-kind and hostile handles before property access', () => {
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps++; throw Error('get'); }, ownKeys() { traps++; throw Error('keys'); }, getPrototypeOf() { traps++; throw Error('prototype'); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); const real = inputHandle();
    const getter = { get policy() { traps++; throw Error('policy'); } };
    const readSources = vi.spyOn(pnl, 'calculatePnlEquity'); const compare = vi.spyOn(arithmetic, 'compare');
    for (const raw of [null, undefined, 0, NaN, Infinity, Symbol('bad'), 1n, {}, baseline(), getter, proxy, revoked.proxy,
        Object.create(real), { ...real }, new Proxy(real, {}), contextHandle()]) {
        const a = calculateMaintenanceVerdict(raw as PreparedMarginInput);
        expect(a.maintenance).toEqual({ status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] });
        for (const r of Object.values(a.exact)) expect(r).toEqual(a.maintenance);
    }
    expect(traps).toBe(0); expect(readSources).not.toHaveBeenCalled(); expect(compare).not.toHaveBeenCalled();
});

it('rejects absent/invalid modes without defaults and preserves authenticated policy against mutation', () => {
    for (const mode of [undefined, null, '', 'LT', 'le', true, 0, {}, ['lt']]) {
        const b = baseline(); Object.assign(b.policy, { comparison: mode });
        expect(prepareMarginInputJson(JSON.stringify(b)).kind).not.toBe('supported');
    }
    const b = baseline(); Object.assign(b.snapshot, { qtyBase: 2, entryPriceQuotePerBase: 8, netCashQuote: 2 });
    b.snapshot.valuation.priceQuotePerBase = 8; Object.assign(b.policy, { initialMarginRate: .25, maintenanceMarginRate: .125, comparison: 'lt' });
    const h = inputHandle(JSON.stringify(b)); b.policy.comparison = 'lte';
    expect(Reflect.set(h, 'policy', b.policy)).toBe(false);
    const cached = readCanonicalMarginInput(h); if (!cached.ok) throw Error('handle');
    expect(Reflect.set(cached.value, 'inputJson', JSON.stringify(b))).toBe(false);
    expect(valid(calculateMaintenanceVerdict(h).maintenance).detected).toBe(false);
});

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const cash = fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const rate = fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true, noDefaultInfinity: true });
const rates = fc.tuple(rate, rate).filter(([a, b]) => a !== b).map(([a, b]) => [Math.max(a, b), Math.min(a, b)] as const);
it('checks exact policy table, lt=>lte, source invariance and publication prerequisites for 1000 inputs', () => {
    fc.assert(fc.property(positive, positive, positive, cash, rates, fc.constantFrom('LONG' as const, 'SHORT' as const), (q, e, p, c, [i, m], side) => {
        const strictHandle = handle(q, e, p, c, i, m, 'lt', side), nonStrictHandle = handle(q, e, p, c, i, m, 'lte', side);
        const a = calculateMaintenanceVerdict(strictHandle), b = calculateMaintenanceVerdict(nonStrictHandle);
        for (const key of Object.values(exactKeys)) {
            expect(a.exact[key].status).toBe(b.exact[key].status);
            if (a.exact[key].status === 'valid') expect(pair(valid(a.exact[key]))).toEqual(pair(valid(b.exact[key])));
            else expect(a.exact[key].reasons).toEqual(b.exact[key].reasons);
        }
        const order = numeric(arithmetic.compare(valid(a.exact.equityQuote), valid(a.exact.maintenanceMarginQuote)));
        expect(valid(a.exact.maintenance).detected).toBe(order < 0); expect(valid(b.exact.maintenance).detected).toBe(order <= 0);
        if (valid(a.exact.maintenance).detected) expect(valid(b.exact.maintenance).detected).toBe(true);
        expect(valid(a.exact.maintenance).state).toBe(valid(b.exact.maintenance).state);
        if (a.exact.maintenanceBufferQuote.status === 'valid') {
            expect(numeric(arithmetic.compare(a.exact.maintenanceBufferQuote.value, numeric(arithmetic.rational(0n))))).toBe(order);
        }
        const equity = pnl.calculatePnlEquity(strictHandle), margin = margins.calculateMarginRequirements(strictHandle);
        const eligible = equity.equityQuote.status === 'valid' && margin.maintenanceMarginQuote.status === 'valid';
        expect(a.maintenance.status).toBe(eligible ? 'valid' : 'calculation_error');
        expect(b.maintenance.status).toBe(a.maintenance.status);
        if (eligible) expect(a.maintenance).toEqual(a.exact.maintenance); else expect(a.maintenance.value).toBeNull();
    }), { seed: 308, numRuns: 1000 });
}, 30_000);

it('increasing E at fixed MM cannot create a breach; increasing MM at fixed E cannot remove one', () => {
    const smallRate = rate.filter(r => r < 1);
    fc.assert(fc.property(positive, positive, positive, positive, smallRate, smallRate, (q, p, c1, c2, m1, m2) => {
        const lowC = Math.min(c1, c2), highC = Math.max(c1, c2), lowM = Math.min(m1, m2), highM = Math.max(m1, m2);
        for (const mode of ['lt', 'lte'] as const) {
            const a = calculate(q, p, p, lowC, 1, lowM, mode), b = calculate(q, p, p, highC, 1, lowM, mode);
            const d = calculate(q, p, p, lowC, 1, highM, mode);
            expect(pair(valid(a.exact.maintenanceMarginQuote))).toEqual(pair(valid(b.exact.maintenanceMarginQuote)));
            expect(pair(valid(a.exact.equityQuote))).toEqual(pair(valid(d.exact.equityQuote)));
            if (!valid(a.exact.maintenance).detected) expect(valid(b.exact.maintenance).detected).toBe(false);
            if (valid(a.exact.maintenance).detected) expect(valid(d.exact.maintenance).detected).toBe(true);
        }
    }), { seed: 8308, numRuns: 500 });
}, 30_000);

it('matches the existing output contract and requires an authenticated input', () => {
    expectTypeOf<MaintenanceCalculation['maintenance']>().toEqualTypeOf<MarginAssessmentV1['maintenance']>();
    expectTypeOf<MaintenanceCalculation['exact']['maintenance']>().toEqualTypeOf<Result<MaintenanceVerdict>>();
    function compileOnly(): void {
        // @ts-expect-error A schema-shaped object does not authenticate a handle.
        calculateMaintenanceVerdict(baseline());
    }
    void compileOnly;
});

it('isolates production comparison from raw financial arithmetic, publication and external dependencies', () => {
    const source = readFileSync(new URL('maintenance-verdict.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('maintenance-verdict.ts', source, ts.ScriptTarget.Latest, true);
    const allowed = new Set(['../../types/margin-assessment.js', './arithmetic.js', './canonicalization.js', './margin-requirements.js', './pnl-equity.js', './validation.js']);
    const forbidden = new Set(['process', 'Date', 'fetch', 'require', 'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket', 'BigInt', 'Number', 'Math', 'publish', 'subtract', 'epsilon']);
    const ops = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskAsteriskToken]);
    function inspect(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            expect(allowed.has(node.moduleSpecifier.text)).toBe(true);
            if (node.moduleSpecifier.text.includes('/types/')) expect(node.importClause?.isTypeOnly).toBe(true);
        }
        if (ts.isIdentifier(node)) expect(forbidden.has(node.text)).toBe(false);
        if (ts.isBinaryExpression(node)) expect(ops.has(node.operatorToken.kind)).toBe(false);
        if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) expect.fail('No unchecked assertions');
        ts.forEachChild(node, inspect);
    }
    inspect(ast);
});
