import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import ts from 'typescript-5';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { FiniteNumber, Result } from '../../types/margin-assessment.js';
import * as arithmetic from './arithmetic.js';
import { type ExactRational, rationalParts } from './arithmetic.js';
import { type PreparedMarginInput, prepareMarginInputJson } from './canonicalization.js';
import { calculatePnlEquity, type PnlEquityCalculation } from './pnl-equity.js';
import { baseline, contextHandle, inputHandle } from './test-support/identity-fixtures.js';

type Pair = [string, string];
interface MetricVector { exact: Pair; published: { bits: string } | { error: string } }
interface Vector {
    name: string;
    side: 'LONG' | 'SHORT';
    input: { q: string; e: string; p: string; cash: string };
    pnl: MetricVector;
    equity: MetricVector;
}
const corpus: { cases: Vector[] } = JSON.parse(readFileSync(new URL('test-support/pnl-equity-corpus.json', import.meta.url), 'utf8'));

function valid<T>(value: Result<T>): T {
    if (value.status !== 'valid') throw new Error(JSON.stringify(value.reasons));
    return value.value;
}
function numeric<T>(value: arithmetic.NumericResult<T>): T {
    if (!value.ok) throw new Error(value.error.code);
    return value.value;
}
function pair(value: ExactRational): Pair {
    const parts = numeric(rationalParts(value));
    return [String(parts.numerator), String(parts.denominator)];
}
function number(raw: string): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${raw}`));
    return view.getFloat64(0);
}
function bits(value: number): string {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    return view.getBigUint64(0).toString(16).padStart(16, '0');
}
function handle(q: number, e: number, p: number, cash: number, side: 'LONG' | 'SHORT'): PreparedMarginInput {
    const input = baseline();
    Object.assign(input.snapshot, { qtyBase: q, entryPriceQuotePerBase: e, netCashQuote: cash, side });
    input.snapshot.valuation.priceQuotePerBase = p;
    return inputHandle(JSON.stringify(input));
}
const calculate = (q: number, e: number, p: number, cash: number, side: 'LONG' | 'SHORT' = 'LONG') =>
    calculatePnlEquity(handle(q, e, p, cash, side));
function metric(exact: Result<ExactRational>, published: Result<FiniteNumber>, expected: MetricVector): void {
    expect(pair(valid(exact))).toEqual(expected.exact);
    if ('error' in expected.published) {
        expect(published).toEqual({ status: 'calculation_error', value: null, reasons: [expected.published.error] });
    } else {
        const value = valid(published);
        expect(bits(value)).toBe(expected.published.bits);
        expect(Number.isFinite(value)).toBe(true);
        expect(Object.is(value, -0)).toBe(false);
        if (expected.exact[0] !== '0') expect(value).not.toBe(0);
    }
}

afterEach(() => vi.restoreAllMocks());

describe('independent Python Fraction golden results, exact and published separately', () => {
    it.each(corpus.cases)('$name', (row) => {
        const result = calculate(number(row.input.q), number(row.input.e), number(row.input.p), number(row.input.cash), row.side);
        metric(result.exact.unrealizedPnlQuote, result.unrealizedPnlQuote, row.pnl);
        metric(result.exact.equityQuote, result.equityQuote, row.equity);
    });
});

it('pins simple LONG/SHORT profit, loss, zero/negative equity and zero cash', () => {
    expect(valid(calculate(3, 100, 125, 10).unrealizedPnlQuote)).toBe(75);
    expect(valid(calculate(3, 100, 125, 10).equityQuote)).toBe(85);
    expect(valid(calculate(3, 100, 125, 10, 'SHORT').unrealizedPnlQuote)).toBe(-75);
    expect(valid(calculate(3, 100, 125, 10, 'SHORT').equityQuote)).toBe(-65);
    expect(valid(calculate(3, 125, 100, 10).unrealizedPnlQuote)).toBe(-75);
    expect(valid(calculate(3, 125, 100, 10, 'SHORT').unrealizedPnlQuote)).toBe(75);
    expect(valid(calculate(2, 3, 1, 4).equityQuote)).toBe(0);
    expect(valid(calculate(2, 10, 11, 0).equityQuote)).toBe(2);
    expect(valid(calculate(2, 10, 10, -0).equityQuote)).toBe(0);
});

it('retains exact PnL on publication underflow so equity rounds independently', () => {
    const result = calculate(0.5, Number.MIN_VALUE, 2 * Number.MIN_VALUE, Number.MIN_VALUE);
    expect(result.unrealizedPnlQuote).toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_UNDERFLOW'] });
    expect(pair(valid(result.exact.unrealizedPnlQuote))).toEqual(['1', String(1n << 1075n)]);
    expect(pair(valid(result.exact.equityQuote))).toEqual(['3', String(1n << 1075n)]);
    expect(valid(result.equityQuote)).toBe(2 * Number.MIN_VALUE);
});

it('retains overflowing exact PnL for finite equity after cash compensation', () => {
    const result = calculate(2, Number.MAX_VALUE, 1, Number.MAX_VALUE);
    expect(result.unrealizedPnlQuote).toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_OVERFLOW'] });
    expect(result.exact.unrealizedPnlQuote.status).toBe('valid');
    expect(result.exact.equityQuote.status).toBe('valid');
    expect(valid(result.equityQuote)).toBe(-Number.MAX_VALUE);
    const pnl = valid(result.exact.unrealizedPnlQuote);
    const expected = numeric(arithmetic.subtract(numeric(arithmetic.fromBinary64(2)),
        numeric(arithmetic.multiply(numeric(arithmetic.fromBinary64(2)), numeric(arithmetic.fromBinary64(Number.MAX_VALUE))))));
    expect(pair(pnl)).toEqual(pair(expected));
});

it('does not propagate equity publication overflow into valid PnL', () => {
    const result = calculate(Number.MAX_VALUE, 1, 2, Number.MAX_VALUE);
    expect(valid(result.unrealizedPnlQuote)).toBe(Number.MAX_VALUE);
    expect(result.equityQuote).toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_OVERFLOW'] });
    expect(result.exact.equityQuote.status).toBe('valid');
});

it('recovers equity 2^-104 which would be lost by adding already rounded PnL', () => {
    const next = 1 + 2 ** -52;
    const result = calculate(next, 2, next, 1);
    expect(valid(result.unrealizedPnlQuote)).toBe(-1);
    expect(1 + valid(result.unrealizedPnlQuote)).toBe(0);
    expect(pair(valid(result.exact.equityQuote))).toEqual(['1', String(1n << 104n)]);
    expect(valid(result.equityQuote)).toBe(2 ** -104);
});

it('uses only authenticated supported handles and never reads caller object properties', () => {
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps += 1; throw new Error('untrusted getter'); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const real = inputHandle();
    const raw = baseline();
    const values: unknown[] = [undefined, null, 1, -0, NaN, Infinity, 1n, 'text', Symbol('x'),
        {}, raw, { ...real }, new Proxy(real, {}), Object.create(real), proxy, revoked.proxy, contextHandle()];
    for (const value of values) {
        const result = calculatePnlEquity(value as PreparedMarginInput);
        for (const metric of [result.unrealizedPnlQuote, result.equityQuote,
            result.exact.unrealizedPnlQuote, result.exact.equityQuote]) {
            expect(metric).toEqual({ status: 'calculation_error', value: null, reasons: ['CALCULATION_FAILED'] });
        }
    }
    expect(traps).toBe(0);
    const changedAfterPreparation = baseline();
    const prepared = inputHandle(JSON.stringify(changedAfterPreparation));
    const before = calculatePnlEquity(prepared);
    changedAfterPreparation.snapshot.side = 'SHORT';
    changedAfterPreparation.snapshot.qtyBase = Infinity;
    const after = calculatePnlEquity(prepared);
    expect(after.unrealizedPnlQuote).toEqual(before.unrealizedPnlQuote);
    expect(pair(valid(after.exact.unrealizedPnlQuote))).toEqual(pair(valid(before.exact.unrealizedPnlQuote)));
});

it('refuses malformed/unsupported requests before they can receive calculation handles', () => {
    const modifications = [
        (v: ReturnType<typeof baseline>) => { v.snapshot.qtyBase = 0; },
        (v: ReturnType<typeof baseline>) => { v.snapshot.entryPriceQuotePerBase = -1; },
        (v: ReturnType<typeof baseline>) => { v.snapshot.netCashQuote = -1; },
        (v: ReturnType<typeof baseline>) => { Object.assign(v.snapshot, { side: 'UNKNOWN' }); },
        (v: ReturnType<typeof baseline>) => { Object.assign(v.snapshot, { marginMode: 'cross' }); },
        (v: ReturnType<typeof baseline>) => { Object.assign(v.snapshot.instrument, { contractKind: 'inverse_perp' }); },
        (v: ReturnType<typeof baseline>) => { Object.assign(v.policy, { modelVersion: '2' }); },
        (v: ReturnType<typeof baseline>) => { Object.assign(v.policy, { modelId: 'venue-specific' }); },
        (v: ReturnType<typeof baseline>) => { v.snapshot.valuation.priceQuotePerBase = 0; },
    ];
    for (const modify of modifications) {
        const input = baseline();
        modify(input);
        expect(prepareMarginInputJson(JSON.stringify(input)).kind).not.toBe('supported');
        expect(calculatePnlEquity(input as unknown as PreparedMarginInput).equityQuote.status).toBe('calculation_error');
    }
});

describe('controlled propagation of S3-04 errors (fault injection, not reachable input claims)', () => {
    it('maps a multiplication resource refusal to both dependent metrics', () => {
        const h = handle(2, 3, 4, 5, 'LONG');
        vi.spyOn(arithmetic, 'multiply').mockReturnValue({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT', cause: 'resource_limit' } });
        const publish = vi.spyOn(arithmetic, 'publish');
        const result = calculatePnlEquity(h);
        for (const value of [result.unrealizedPnlQuote, result.equityQuote,
            result.exact.unrealizedPnlQuote, result.exact.equityQuote]) {
            expect(value).toEqual({ status: 'calculation_error', value: null, reasons: ['NUMERIC_RESOURCE_LIMIT'] });
        }
        expect(publish).not.toHaveBeenCalled();
    });
    it('maps an equity-only resource refusal without invalidating exact or published PnL', () => {
        vi.spyOn(arithmetic, 'add').mockReturnValue({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT', cause: 'resource_limit' } });
        const result = calculate(2, 3, 4, 5);
        expect(valid(result.unrealizedPnlQuote)).toBe(2);
        expect(pair(valid(result.exact.unrealizedPnlQuote))).toEqual(['2', '1']);
        expect(result.equityQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
        expect(result.exact.equityQuote.reasons).toEqual(['NUMERIC_RESOURCE_LIMIT']);
    });
    it('propagates controlled decoder failures without a finite-number assertion or fallback', () => {
        vi.spyOn(arithmetic, 'fromBinary64').mockReturnValue({ ok: false, error: { code: 'CALCULATION_FAILED', cause: 'invalid_input' } });
        const result = calculate(2, 3, 4, 5);
        expect(result.unrealizedPnlQuote.reasons).toEqual(['CALCULATION_FAILED']);
        expect(result.equityQuote.reasons).toEqual(['CALCULATION_FAILED']);
    });
});

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
const cash = fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true });
it('keeps exact break-even, sign reversal, cash addition and publication independence for 1000 binary64 inputs', () => {
    fc.assert(fc.property(positive, positive, positive, cash, (q, e, p, c) => {
        const long = calculate(q, e, p, c);
        const short = calculate(q, e, p, c, 'SHORT');
        const flat = calculate(q, e, e, c);
        const lp = valid(long.exact.unrealizedPnlQuote);
        const sp = valid(short.exact.unrealizedPnlQuote);
        expect(pair(numeric(arithmetic.add(lp, sp)))).toEqual(['0', '1']);
        expect(pair(valid(flat.exact.unrealizedPnlQuote))).toEqual(['0', '1']);
        expect(valid(flat.unrealizedPnlQuote)).toBe(0);
        expect(valid(flat.equityQuote)).toBe(c === 0 ? 0 : c);
        const expectedEquity = numeric(arithmetic.add(numeric(arithmetic.fromBinary64(c)), lp));
        expect(pair(valid(long.exact.equityQuote))).toEqual(pair(expectedEquity));
        for (const result of [long, short]) {
            for (const [exact, published] of [
                [result.exact.unrealizedPnlQuote, result.unrealizedPnlQuote],
                [result.exact.equityQuote, result.equityQuote],
            ] as const) {
                const handle = valid(exact);
                const before = pair(handle);
                const independent = arithmetic.publish(handle);
                if (independent.ok) expect(valid(published)).toBe(independent.value);
                else expect(published.reasons).toEqual([independent.error.code]);
                expect(pair(handle)).toEqual(before);
                if (published.status === 'valid') {
                    expect(Number.isFinite(published.value)).toBe(true);
                    expect(Object.is(published.value, -0)).toBe(false);
                    if (before[0] !== '0') expect(published.value).not.toBe(0);
                }
            }
        }
    }), { seed: 305, numRuns: 1000 });
}, 30_000);

it('increasing price raises LONG PnL and lowers SHORT PnL before any rounding', () => {
    fc.assert(fc.property(positive, positive, positive, positive, (q, e, a, b) => {
        const low = Math.min(a, b);
        const high = Math.max(a, b);
        const longLow = valid(calculate(q, e, low, 0).exact.unrealizedPnlQuote);
        const longHigh = valid(calculate(q, e, high, 0).exact.unrealizedPnlQuote);
        const shortLow = valid(calculate(q, e, low, 0, 'SHORT').exact.unrealizedPnlQuote);
        const shortHigh = valid(calculate(q, e, high, 0, 'SHORT').exact.unrealizedPnlQuote);
        expect(numeric(arithmetic.compare(longLow, longHigh))).toBe(low === high ? 0 : -1);
        expect(numeric(arithmetic.compare(shortLow, shortHigh))).toBe(low === high ? 0 : 1);
    }), { seed: 5305, numRuns: 500 });
}, 30_000);

it('keeps calculation and publication types distinct, requiring prepared input', () => {
    expectTypeOf<PnlEquityCalculation['unrealizedPnlQuote']>().toEqualTypeOf<Result<FiniteNumber>>();
    expectTypeOf<PnlEquityCalculation['exact']['equityQuote']>().toEqualTypeOf<Result<ExactRational>>();
    function compileOnly(): void {
        // @ts-expect-error A schema-typed object is not an authenticated handle.
        calculatePnlEquity(baseline());
        // @ts-expect-error Raw numbers are not a position handle.
        calculatePnlEquity(1);
        // @ts-expect-error Exact internal results cannot enter a published field.
        const result: Result<FiniteNumber> = calculatePnlEquity(inputHandle()).exact.equityQuote;
        void result;
    }
    void compileOnly;
});

it('restricts production dependencies and arithmetic to existing Stage 3 foundations', () => {
    const source = readFileSync(new URL('pnl-equity.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('pnl-equity.ts', source, ts.ScriptTarget.Latest, true);
    const allowed = new Set(['../../types/margin-assessment.js', './arithmetic.js', './canonicalization.js', './validation.js']);
    const forbidden = new Set(['process', 'Date', 'fetch', 'require', 'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket', 'BigInt', 'Number', 'Math']);
    const financialOperators = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskAsteriskToken]);
    function inspect(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
            if (ts.isStringLiteral(node.moduleSpecifier)) expect(allowed.has(node.moduleSpecifier.text)).toBe(true);
            if (node.moduleSpecifier.getText(ast).includes('/types/')) expect(node.importClause?.isTypeOnly).toBe(true);
        }
        if (ts.isIdentifier(node)) expect(forbidden.has(node.text)).toBe(false);
        if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isBinaryExpression(node)) expect(financialOperators.has(node.operatorToken.kind)).toBe(false);
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) expect.fail('No type assertion may issue a number or trust a position');
        ts.forEachChild(node, inspect);
    }
    inspect(ast);
});
