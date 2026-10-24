import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import ts from 'typescript-5';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { BoundaryValue, MaintenanceVerdict, Result } from '../../types/margin-assessment.js';
import type { ExactRational } from './arithmetic.js';
import * as arithmetic from './arithmetic.js';
import { type PreparedMarginInput, prepareMarginInputJson } from './canonicalization.js';
import { calculateLiquidationBoundary, type LiquidationBoundaryCalculation } from './liquidation-boundary.js';
import * as verdict from './maintenance-verdict.js';
import { baseline, contextHandle, inputHandle } from './test-support/identity-fixtures.js';

type Mode = 'lt' | 'lte';
type Pair = [string, string];
interface Vector {
    name: string;
    side: 'LONG' | 'SHORT';
    relation: -1 | 0 | 1;
    state: 'above_threshold' | 'at_threshold' | 'below_threshold';
    inputs: Record<'q' | 'e' | 'p' | 'cash' | 'i' | 'm', string>;
    exact: { kind: 'root'; parts: Pair; probe: { up: string | null; down: string | null } | null }
        | { kind: 'none'; proofId: string };
    verdicts: Record<Mode, {
        detected: boolean;
        boundary: { status: 'valid'; value: { kind: 'already_breached' } }
            | { status: 'valid'; value: { kind: 'unreachable'; path: string; domain: string; proofId: string } }
            | { status: 'valid'; kind: 'boundary'; bits: string; triggers: boolean; path: string }
            | { status: 'calculation_error'; reasons: string[] };
    }>;
}
const corpus: { cases: Vector[] } = JSON.parse(readFileSync(new URL('test-support/liquidation-boundary-corpus.json', import.meta.url), 'utf8'));
function number(raw: string): number { const v = new DataView(new ArrayBuffer(8)); v.setBigUint64(0, BigInt(`0x${raw}`)); return v.getFloat64(0); }
function bits(n: number): string { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, n); return v.getBigUint64(0).toString(16).padStart(16, '0'); }
function numeric<T>(r: arithmetic.NumericResult<T>): T { if (!r.ok) throw Error(r.error.code); return r.value; }
function pair(v: ExactRational): Pair { const p = numeric(arithmetic.rationalParts(v)); return [String(p.numerator), String(p.denominator)]; }
function handle(q: number, e: number, p: number, cash: number, i: number, m: number, mode: Mode, side: 'LONG' | 'SHORT' = 'LONG'): PreparedMarginInput {
    const input = baseline();
    Object.assign(input.snapshot, { qtyBase: q, entryPriceQuotePerBase: e, netCashQuote: cash, side });
    input.snapshot.valuation.priceQuotePerBase = p;
    Object.assign(input.policy, { initialMarginRate: i, maintenanceMarginRate: m, comparison: mode });
    return inputHandle(JSON.stringify(input));
}
const calculate = (q: number, e: number, p: number, cash: number, i: number, m: number, mode: Mode, side: 'LONG' | 'SHORT' = 'LONG') =>
    calculateLiquidationBoundary(handle(q, e, p, cash, i, m, mode, side));
function rootParts(a: LiquidationBoundaryCalculation): Pair | null {
    const exact = a.exact.boundary;
    if (exact.status !== 'valid' || exact.value.kind !== 'root') return null;
    return pair(exact.value.rootQuote);
}
function comparePair(a: Pair, b: Pair): number {
    const left = BigInt(a[0]) * BigInt(b[1]);
    const right = BigInt(b[0]) * BigInt(a[1]);
    return left < right ? -1 : left > right ? 1 : 0;
}
const resource = { ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT', cause: 'resource_limit' } } as const;
const resourceResult = { status: 'calculation_error', value: null, reasons: ['NUMERIC_RESOURCE_LIMIT'] } as const;
const overflowResult = { status: 'calculation_error', value: null, reasons: ['NUMERIC_OVERFLOW'] } as const;
const breach = { status: 'valid', value: { kind: 'already_breached' }, reasons: [] } as const;
afterEach(() => vi.restoreAllMocks());

describe('independent Python Fraction corpus: exact roots, unreachable proofs and breach precedence', () => {
    it.each(corpus.cases)('$name', (row) => {
        const v = row.inputs;
        for (const mode of ['lt', 'lte'] as const) {
            const h = handle(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), mode, row.side);
            const a = calculateLiquidationBoundary(h);
            const expectedVerdict: Result<MaintenanceVerdict> = {
                status: 'valid', reasons: [], value: {
                    exactRelation: row.relation > 0 ? 'positive' : row.relation < 0 ? 'negative' : 'zero',
                    comparison: mode, state: row.state, detected: row.verdicts[mode].detected,
                },
            };
            expect(a.exact.maintenance).toEqual(expectedVerdict);
            expect(verdict.calculateMaintenanceVerdict(h).exact.maintenance).toEqual(a.exact.maintenance);
            if (row.exact.kind === 'root') {
                expect(a.exact.boundary.status).toBe('valid');
                if (a.exact.boundary.status !== 'valid' || a.exact.boundary.value.kind !== 'root') throw Error('root');
                expect(pair(a.exact.boundary.value.rootQuote)).toEqual(row.exact.parts);
            } else {
                expect(a.exact.boundary).toEqual({ status: 'valid', reasons: [], value: { kind: 'none', proofId: row.exact.proofId } });
            }
            const want = row.verdicts[mode].boundary;
            const b = a.boundary;
            expect(b.status).toBe(want.status);
            if (want.status !== 'valid') {
                expect(b.value).toBeNull();
                expect(b.reasons).toEqual(want.reasons);
            } else if ('kind' in want) {
                if (b.status !== 'valid' || b.value.kind !== 'boundary') throw Error('boundary');
                expect(bits(b.value.priceQuotePerBase)).toBe(want.bits);
                expect(b.value.triggersAtExactBoundary).toBe(want.triggers);
                expect(b.value.path).toBe(want.path);
                expect(b.value.publication).toBe('rounded_exact_boundary');
                expect(b.value.boundaryKind).toBe('root');
                expect(b.value.domain).toBe('positive_real_prices');
                expect(b.reasons).toEqual([]);
            } else {
                expect({ status: b.status, value: b.value }).toEqual({ status: want.status, value: want.value });
                expect(b.reasons).toEqual([]);
            }
        }
        if (row.exact.kind === 'root') {
            const strict = rootParts(calculate(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), 'lt', row.side));
            const nonStrict = rootParts(calculate(number(v.q), number(v.e), number(v.p), number(v.cash), number(v.i), number(v.m), 'lte', row.side));
            expect(strict).toEqual(row.exact.parts);
            expect(nonStrict).toEqual(row.exact.parts);
        }
    });
});

it('verifies exact H signs on both sides of representable roots through the S3-08 state', () => {
    for (const row of corpus.cases) {
        if (row.exact.kind !== 'root' || row.exact.probe === null) continue;
        const v = row.inputs;
        for (const [key, direction] of [['up', 1], ['down', -1]] as const) {
            const probe = row.exact.probe[key];
            if (probe === null) continue;
            const a = calculate(number(v.q), number(v.e), number(probe), number(v.cash), number(v.i), number(v.m), 'lt', row.side);
            const relation = row.side === 'LONG' ? direction : -direction;
            expect(a.exact.maintenance).toEqual({
                status: 'valid', reasons: [], value: {
                    exactRelation: relation === 1 ? 'positive' : 'negative', comparison: 'lt',
                    state: relation === 1 ? 'above_threshold' : 'below_threshold', detected: relation < 0,
                },
            });
            expect(rootParts(a)).toEqual(row.exact.parts);
        }
    }
});

describe('controlled failures and publication prerequisites', () => {
    it('propagates a kernel division refusal on the exact root', () => {
        vi.spyOn(arithmetic, 'divide').mockReturnValueOnce(resource);
        const a = calculate(2, 8, 12, 0, .5, .25, 'lt');
        expect(a.exact.boundary).toEqual(resourceResult);
        expect(a.boundary).toEqual(resourceResult);
    });
    it('propagates denominator and numerator sign-check refusals without dividing', () => {
        const original = arithmetic.compare;
        let calls = 0;
        vi.spyOn(arithmetic, 'compare').mockImplementation((left, right) => ++calls === 2 ? resource : original(left, right));
        const denominator = calculate(2, 8, 12, 0, .5, .25, 'lt');
        expect(denominator.exact.boundary).toEqual(resourceResult);
        expect(denominator.boundary).toEqual(resourceResult);
        vi.restoreAllMocks();
        let second = 0;
        vi.spyOn(arithmetic, 'compare').mockImplementation((left, right) => ++second === 3 ? resource : original(left, right));
        const numerator = calculate(2, 8, 12, 0, .5, .25, 'lt');
        expect(numerator.exact.boundary).toEqual(resourceResult);
        expect(numerator.boundary).toEqual(resourceResult);
    });
    it('keeps the exact root when its publication overflows and publishes exactly once', () => {
        const root = rootParts(calculate(2, 8, 12, 0, .5, .25, 'lt'));
        if (root === null) throw Error('root');
        const original = arithmetic.publish;
        let calls = 0;
        vi.spyOn(arithmetic, 'publish').mockImplementation((value) => {
            const parts = pair(value);
            if (parts[0] !== root[0] || parts[1] !== root[1]) return original(value);
            calls += 1;
            return { ok: false, error: { code: 'NUMERIC_OVERFLOW', cause: 'overflow' } };
        });
        const a = calculate(2, 8, 12, 0, .5, .25, 'lt');
        expect(calls).toBe(1);
        expect(rootParts(a)).toEqual(root);
        expect(a.boundary).toEqual(overflowResult);
    });
    it('never publishes for a current breach or an unreachable boundary', () => {
        const root = rootParts(calculate(2, 8, 10, 0, .5, .25, 'lt'));
        if (root === null) throw Error('root');
        const publish = vi.spyOn(arithmetic, 'publish');
        expect(calculate(2, 8, 10, 0, .5, .25, 'lt').boundary).toEqual(breach);
        expect(calculate(3, 5, 7, 15, .75, .5, 'lte').boundary).toEqual({
            status: 'valid', value: {
                kind: 'unreachable', path: 'long_price_decrease',
                domain: 'positive_real_prices', proofId: 'flat-linear-long-cash-ge-entry-notional@1',
            }, reasons: [],
        });
        expect(publish.mock.calls.filter((call) => pair(call[0]).join('/') === root.join('/'))).toEqual([]);
    });
    it('lets the exact S3-08 state claim the single boundary slot even with a root', () => {
        const original = verdict.calculateMaintenanceVerdict;
        vi.spyOn(verdict, 'calculateMaintenanceVerdict').mockImplementation((h) => {
            const r = original(h);
            return {
                ...r, exact: {
                    ...r.exact, maintenance: {
                        status: 'valid', reasons: [], value: {
                            exactRelation: 'negative', comparison: 'lt', state: 'below_threshold', detected: true,
                        },
                    },
                },
            };
        });
        const a = calculate(2, 8, 12, 0, .5, .25, 'lt');
        expect(a.boundary).toEqual(breach);
        expect(rootParts(a)).not.toBeNull();
    });
    it('propagates an unavailable exact maintenance state without fabricating a boundary', () => {
        vi.spyOn(verdict, 'calculateMaintenanceVerdict').mockImplementation(() => ({
            exact: {
                equityQuote: resourceResult, maintenanceMarginQuote: resourceResult,
                maintenanceBufferQuote: resourceResult, maintenance: resourceResult,
            },
            maintenance: resourceResult,
        }));
        const a = calculate(2, 8, 12, 0, .5, .25, 'lt');
        expect(a.exact.maintenance).toEqual(resourceResult);
        expect(a.boundary).toEqual(resourceResult);
        expect(a.boundary.value).toBeNull();
    });
});

it('rejects forged, revoked, wrong-kind and hostile handles before property access', () => {
    let traps = 0;
    const proxy = new Proxy({}, {
        get() { traps++; throw Error('get'); }, ownKeys() { traps++; throw Error('keys'); },
        getPrototypeOf() { traps++; throw Error('prototype'); },
    });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const real = inputHandle();
    const getter = { get policy() { traps++; throw Error('policy'); } };
    const solver = vi.spyOn(verdict, 'calculateMaintenanceVerdict');
    for (const raw of [null, undefined, 0, NaN, Infinity, Symbol('bad'), 1n, {}, baseline(), getter, proxy, revoked.proxy,
        Object.create(real), { ...real }, new Proxy(real, {}), contextHandle()]) {
        const a = calculateLiquidationBoundary(raw as PreparedMarginInput);
        const failed = { status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] };
        expect(a.boundary).toEqual(failed);
        expect(a.exact.maintenance).toEqual(failed);
        expect(a.exact.boundary).toEqual(failed);
    }
    expect(traps).toBe(0);
    expect(solver).not.toHaveBeenCalled();
});

it('requires an authenticated input and keeps policy-driven triggers immutable against mutation', () => {
    for (const mode of [undefined, null, '', 'LT', 'le', true, 0, {}, ['lte']]) {
        const b = baseline();
        Object.assign(b.policy, { comparison: mode });
        expect(prepareMarginInputJson(JSON.stringify(b)).kind).not.toBe('supported');
    }
    const b = baseline();
    Object.assign(b.snapshot, { qtyBase: 2, entryPriceQuotePerBase: 8, netCashQuote: 3 });
    b.snapshot.valuation.priceQuotePerBase = 12;
    Object.assign(b.policy, { initialMarginRate: .5, maintenanceMarginRate: .25, comparison: 'lt' });
    const h = inputHandle(JSON.stringify(b));
    b.policy.comparison = 'lte';
    expect(Reflect.set(h, 'boundary', {})).toBe(false);
    const a = calculateLiquidationBoundary(h);
    if (a.boundary.status !== 'valid' || a.boundary.value.kind !== 'boundary') throw Error('boundary');
    expect(a.boundary.value.triggersAtExactBoundary).toBe(false);
});

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const cash = fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const rate = fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true, noDefaultInfinity: true });
const smallRate = rate.filter((value) => value < 1);
const rates = fc.tuple(rate, rate).filter(([a, b]) => a !== b).map(([a, b]) => [Math.max(a, b), Math.min(a, b)] as const);

it('keeps the exact root independent of valuation price, comparison and eligibility', () => {
    fc.assert(fc.property(positive, positive, positive, cash, rates, fc.constantFrom('LONG' as const, 'SHORT' as const),
        (q, e, p, c, [i, m], side) => {
            const moved = p <= Number.MAX_VALUE / 2 ? p * 2 : p / 2;
            const strict = calculate(q, e, p, c, i, m, 'lt', side);
            const nonStrict = calculate(q, e, p, c, i, m, 'lte', side);
            const relocated = calculate(q, e, moved, c, i, m, 'lt', side);
            expect(rootParts(strict)).toEqual(rootParts(nonStrict));
            expect(rootParts(strict)).toEqual(rootParts(relocated));
            expect(strict.exact.boundary.status).toBe(nonStrict.exact.boundary.status);
            expect(strict.exact.boundary.status).toBe(relocated.exact.boundary.status);
            const state = strict.exact.maintenance;
            if (state.status !== 'valid') throw Error('state');
            const isBreach = strict.boundary.status === 'valid' && strict.boundary.value.kind === 'already_breached';
            expect(isBreach).toBe(state.value.detected);
        }), { seed: 309, numRuns: 400 });
}, 30_000);

it('moves the boundary monotonically: cash against LONG, with SHORT; maintenance rate reversed', () => {
    fc.assert(fc.property(positive, positive, positive, cash, cash, smallRate, smallRate,
        (q, e, p, c1, c2, m1, m2) => {
            const lowC = Math.min(c1, c2), highC = Math.max(c1, c2), lowM = Math.min(m1, m2), highM = Math.max(m1, m2);
            for (const mode of ['lt', 'lte'] as const) {
                const longLow = rootParts(calculate(q, e, p, lowC, 1, lowM, mode, 'LONG'));
                const longHigh = rootParts(calculate(q, e, p, highC, 1, lowM, mode, 'LONG'));
                if (longLow === null) expect(longHigh).toBeNull();
                else if (longHigh !== null) expect(comparePair(longHigh, longLow)).toBeLessThanOrEqual(0);
                const shortLow = rootParts(calculate(q, e, p, lowC, 1, lowM, mode, 'SHORT'));
                const shortHigh = rootParts(calculate(q, e, p, highC, 1, lowM, mode, 'SHORT'));
                if (shortLow !== null && shortHigh !== null) expect(comparePair(shortHigh, shortLow)).toBeGreaterThanOrEqual(0);
                const longLowM = rootParts(calculate(q, e, p, lowC, 1, lowM, mode, 'LONG'));
                const longHighM = rootParts(calculate(q, e, p, lowC, 1, highM, mode, 'LONG'));
                if (longLowM !== null && longHighM !== null) expect(comparePair(longHighM, longLowM)).toBeGreaterThanOrEqual(0);
                const shortLowM = rootParts(calculate(q, e, p, lowC, 1, lowM, mode, 'SHORT'));
                const shortHighM = rootParts(calculate(q, e, p, lowC, 1, highM, mode, 'SHORT'));
                if (shortLowM !== null && shortHighM !== null) expect(comparePair(shortHighM, shortLowM)).toBeLessThanOrEqual(0);
            }
        }), { seed: 8309, numRuns: 400 });
}, 30_000);

it('matches the approved boundary contract and requires an authenticated input', () => {
    expectTypeOf<LiquidationBoundaryCalculation['boundary']>().toEqualTypeOf<Result<BoundaryValue>>();
    function compileOnly(): void {
        // @ts-expect-error A schema-shaped object does not authenticate a handle.
        calculateLiquidationBoundary(baseline());
    }
    void compileOnly;
});

it('isolates the solver from raw financial arithmetic, publication loops and external dependencies', () => {
    const source = readFileSync(new URL('liquidation-boundary.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('liquidation-boundary.ts', source, ts.ScriptTarget.Latest, true);
    const allowed = new Set(['../../types/margin-assessment.js', './arithmetic.js', './canonicalization.js', './maintenance-verdict.js', './validation.js']);
    const forbidden = new Set(['process', 'Date', 'fetch', 'require', 'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket', 'BigInt', 'Number', 'Math', 'epsilon', 'parseFloat', 'parseInt', 'isNaN']);
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
