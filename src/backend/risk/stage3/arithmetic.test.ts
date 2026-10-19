import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import ts from 'typescript-5';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FiniteNumber } from '../../types/margin-assessment.js';
import {
    ARITHMETIC_LIMITS, add, compare, divide, type ExactComparison, type ExactRational,
    fromBinary64, multiply, type NumericResult, publish, rational, rationalParts,
    STAGE3_ARITHMETIC_VERSION, subtract, testRelation,
} from './arithmetic.js';

type Pair = [string, string];
interface Corpus {
    decodes: { bits: string; exact: Pair }[];
    operations: { op: 'add' | 'subtract' | 'multiply' | 'divide'; a: Pair; b: Pair; exact: Pair | null;
        error: string | null; order: -1 | 0 | 1; published: string | null }[];
    publications: { exact: Pair; published: string }[];
    constructors: { raw: Pair; exact: Pair | null; error: string | null }[];
}
const corpus: Corpus = JSON.parse(readFileSync(new URL('test-support/arithmetic-corpus.json', import.meta.url), 'utf8'));
function unwrap<T>(result: NumericResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
}
const q = (n: bigint, d = 1n): ExactRational => unwrap(rational(n, d));
const fromPair = ([n, d]: Pair): ExactRational => q(BigInt(n), BigInt(d));
const exact = (value: number): ExactRational => unwrap(fromBinary64(value));
function pair(value: ExactRational): Pair {
    const parts = unwrap(rationalParts(value));
    return [String(parts.numerator), String(parts.denominator)];
}
function bits(value: number): string {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    return view.getBigUint64(0).toString(16).padStart(16, '0');
}
function number(encoded: string): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${encoded}`));
    return view.getFloat64(0);
}
function publication(value: ExactRational): string {
    const result = publish(value);
    if (!result.ok) return result.error.code;
    expect(Number.isFinite(result.value)).toBe(true);
    expect(Object.is(result.value, -0)).toBe(false);
    if (unwrap(rationalParts(value)).numerator !== 0n) expect(result.value).not.toBe(0);
    return bits(result.value);
}

describe('independent Python fractions.Fraction golden corpus', () => {
    it.each(corpus.decodes)('decodes $bits exactly and round trips', (row) => {
        const result = exact(number(row.bits));
        expect(pair(result)).toEqual(row.exact);
        expect(publication(result)).toBe(row.bits === '8000000000000000' ? '0000000000000000' : row.bits);
    });
    it.each(corpus.operations.map((row, index) => ({ ...row, index })))('operation $index: $op', (row) => {
        const a = fromPair(row.a);
        const b = fromPair(row.b);
        const result = { add, subtract, multiply, divide }[row.op](a, b);
        if (row.error) {
            expect(result).toMatchObject({ ok: false, error: { cause: row.error } });
        } else {
            const value = unwrap(result);
            expect(pair(value)).toEqual(row.exact);
            expect(publication(value)).toBe(row.published);
        }
        expect(unwrap(compare(a, b))).toBe(row.order);
        const relations: [ExactComparison, boolean][] = [
            ['lt', row.order < 0], ['lte', row.order <= 0], ['eq', row.order === 0],
            ['gt', row.order > 0], ['gte', row.order >= 0],
        ];
        for (const [relation, expected] of relations) expect(unwrap(testRelation(a, b, relation))).toBe(expected);
    });
    it.each(corpus.publications.map((row, index) => ({ ...row, index })))('rounds publication $index', (row) => {
        expect(publication(fromPair(row.exact))).toBe(row.published);
    });
    it.each(corpus.constructors.map((row, index) => ({ ...row, index })))('bounds/normalizes constructor $index', (row) => {
        const result = rational(BigInt(row.raw[0]), BigInt(row.raw[1]));
        if (row.error) expect(result).toMatchObject({ ok: false, error: { cause: row.error } });
        else expect(pair(unwrap(result))).toEqual(row.exact);
    });
});

it('pins small, independently reviewable golden vectors', () => {
    expect(pair(exact(0.1))).toEqual(['3602879701896397', '36028797018963968']);
    expect(pair(q(-6n, -8n))).toEqual(['3', '4']);
    expect(pair(q(0n, -999n))).toEqual(['0', '1']);
    expect(pair(unwrap(add(q(1n, 3n), q(1n, 6n))))).toEqual(['1', '2']);
    expect(publication(q(1n, 3n))).toBe('3fd5555555555555');
    expect(publication(q((1n << 53n) + 1n, 1n << 53n))).toBe('3ff0000000000000');
    expect(publication(q((1n << 53n) + 3n, 1n << 53n))).toBe('3ff0000000000002');
    expect(publication(q(1n, 1n << 1075n))).toBe('NUMERIC_UNDERFLOW');
    expect(publication(q(3n, 1n << 1075n))).toBe('0000000000000002');
    expect(publication(q(-3n, 1n << 1075n))).toBe('8000000000000002');
    const overflowMidpoint = (1n << 1024n) - (1n << 970n);
    expect(publication(q(overflowMidpoint - 1n))).toBe('7fefffffffffffff');
    expect(publication(q(overflowMidpoint))).toBe('NUMERIC_OVERFLOW');
});

it('distinguishes exact equality and strict/non-strict relations before rounding', () => {
    const a = q(1n);
    const same = q(10n, 10n);
    const close = q((1n << 4000n) + 1n, 1n << 4000n);
    expect(publication(a)).toBe(publication(close));
    for (const [relation, equalExpected, closeExpected] of [
        ['lt', false, true], ['lte', true, true], ['eq', true, false], ['gt', false, false], ['gte', true, false],
    ] as const) {
        expect(unwrap(testRelation(a, same, relation))).toBe(equalExpected);
        expect(unwrap(testRelation(a, close, relation))).toBe(closeExpected);
    }
});

it('preserves recoverable exact results through false-zero/infinity JS intermediates', () => {
    expect(Number.MIN_VALUE * 0.5).toBe(0);
    const tiny = unwrap(multiply(exact(Number.MIN_VALUE), q(1n, 2n)));
    expect(publication(tiny)).toBe('NUMERIC_UNDERFLOW');
    expect(unwrap(publish(unwrap(multiply(tiny, q(2n)))))).toBe(Number.MIN_VALUE);
    expect(Number.MAX_VALUE * 2).toBe(Infinity);
    const huge = unwrap(multiply(exact(Number.MAX_VALUE), q(2n)));
    expect(publication(huge)).toBe('NUMERIC_OVERFLOW');
    expect(unwrap(publish(unwrap(divide(huge, q(2n)))))).toBe(Number.MAX_VALUE);
    expect(unwrap(publish(unwrap(subtract(huge, huge))))).toBe(0);
});

it('enforces fixed resource bounds before reduction and after bounded scratch work', () => {
    expect(STAGE3_ARITHMETIC_VERSION).toBe('stage3-rational@1');
    expect(ARITHMETIC_LIMITS).toEqual({ componentBits: 4096, scratchBits: 8193, gcdSteps: 20_000 });
    expect(Object.isFrozen(ARITHMETIC_LIMITS)).toBe(true);
    const bound = 1n << 4096n;
    for (const [n, d] of [[bound, 1n], [-bound, 1n], [1n, bound], [0n, bound], [bound, bound]]) {
        expect(rational(n!, d!)).toMatchObject({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT' } });
    }
    const max = q(bound - 1n);
    expect(add(max, q(1n))).toMatchObject({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT' } });
    expect(subtract(q(-bound + 1n), q(1n))).toMatchObject({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT' } });
    expect(multiply(max, max)).toMatchObject({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT' } });
    expect(divide(max, q(1n, bound - 1n))).toMatchObject({ ok: false, error: { code: 'NUMERIC_RESOURCE_LIMIT' } });
    const large = q(bound - 1n, bound - 2n);
    expect(pair(unwrap(add(large, large)))).toEqual([String(bound - 1n), String((bound - 2n) / 2n)]);
    expect(pair(unwrap(divide(large, large)))).toEqual(['1', '1']);
    expect(pair(unwrap(subtract(large, large)))).toEqual(['0', '1']);
    // Consecutive Fibonacci values exercise near-worst Euclidean complexity.
    let a = 1n;
    let b = 1n;
    while (a + b < bound) [a, b] = [b, a + b];
    expect(pair(q(a, b))).toEqual([String(a), String(b)]);
});

it('rejects division by zero, nonfinite inputs and untrusted handles without coercion or traps', () => {
    for (const zero of [q(0n), exact(-0)]) {
        expect(divide(q(0n), zero)).toMatchObject({ ok: false, error: { cause: 'division_by_zero' } });
        expect(divide(q(1n), zero)).toMatchObject({ ok: false, error: { cause: 'division_by_zero' } });
    }
    for (const value of [NaN, Infinity, -Infinity]) expect(fromBinary64(value)).toMatchObject({ ok: false });
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps += 1; throw new Error('trap'); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const handle = q(1n);
    for (const raw of [{}, { numerator: 1n, denominator: 1n }, proxy, revoked.proxy, null, 1, { ...handle }, new Proxy(handle, {})]) {
        const forged = raw as ExactRational;
        expect(publish(forged)).toMatchObject({ ok: false, error: { cause: 'untrusted_value' } });
        expect(add(handle, forged)).toMatchObject({ ok: false });
        expect(compare(forged, handle)).toMatchObject({ ok: false });
    }
    expect(fromBinary64(proxy as number)).toMatchObject({ ok: false });
    expect(rational(proxy as bigint)).toMatchObject({ ok: false });
    expect(traps).toBe(0);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(unwrap(rationalParts(handle)))).toBe(true);
});

it('round trips 1000 deterministic arbitrary finite binary64 patterns', () => {
    fc.assert(fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (value) => {
        const result = exact(value);
        expect(unwrap(publish(result))).toBe(value === 0 ? 0 : value);
        const parts = unwrap(rationalParts(result));
        expect(parts.denominator > 0n).toBe(true);
        if (value === 0) expect(parts).toEqual({ numerator: 0n, denominator: 1n });
    }), { seed: 304, numRuns: 1000 });
});

it('satisfies exact algebra, order and publication symmetry for 500 rational pairs', () => {
    const fraction = fc.tuple(fc.bigInt({ min: -(1n << 256n), max: 1n << 256n }),
        fc.bigInt({ min: 1n, max: 1n << 256n }));
    fc.assert(fc.property(fraction, fraction, ([an, ad], [bn, bd]) => {
        const a = q(an, ad);
        const b = q(bn, bd);
        expect(pair(unwrap(subtract(unwrap(add(a, b)), b)))).toEqual(pair(a));
        expect(pair(unwrap(multiply(a, b)))).toEqual(pair(unwrap(multiply(b, a))));
        if (bn !== 0n) expect(pair(unwrap(divide(unwrap(multiply(a, b)), b)))).toEqual(pair(a));
        const cross = an * bd - bn * ad;
        expect(unwrap(compare(a, b))).toBe(cross < 0n ? -1 : cross > 0n ? 1 : 0);
        const positive = publish(a);
        const negative = publish(q(-an, ad));
        if (positive.ok && negative.ok) expect(negative.value).toBe(positive.value === 0 ? 0 : -positive.value);
        else expect(positive.ok ? null : positive.error.code).toBe(negative.ok ? null : negative.error.code);
    }), { seed: 304, numRuns: 500 });
});

it('has separate exact, finite-publication and error types', () => {
    expectTypeOf(publish(q(1n))).toEqualTypeOf<NumericResult<FiniteNumber>>();
    expectTypeOf(fromBinary64(1)).toEqualTypeOf<NumericResult<ExactRational>>();
    // Compile-only negative checks: these calls must never run.
    function typeChecks(internal: ExactRational, plain: number): void {
        // @ts-expect-error Exact values are not published numbers.
        const invalid: FiniteNumber = internal;
        // @ts-expect-error An unchecked number cannot acquire the publication brand.
        const unchecked: FiniteNumber = plain;
        // @ts-expect-error Public gate requires a module-issued rational.
        publish(plain);
        void invalid;
        void unchecked;
    }
    void typeChecks;
});

it('isolates the kernel from IO, legacy arithmetic, identity, schemas and runtime output imports', () => {
    const source = readFileSync(new URL('arithmetic.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('arithmetic.ts', source, ts.ScriptTarget.Latest, true);
    const forbidden = new Set(['process', 'Date', 'fetch', 'require', 'eval', 'Function', 'setTimeout', 'setInterval', 'WebSocket']);
    let imports = 0;
    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            imports += 1;
            expect(node.moduleSpecifier.getText(ast)).toBe("'../../types/margin-assessment.js'");
            expect(node.importClause?.isTypeOnly).toBe(true);
        }
        if (ts.isCallExpression(node)) expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        if (ts.isIdentifier(node)) expect(forbidden.has(node.text)).toBe(false);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(imports).toBe(1);
});
