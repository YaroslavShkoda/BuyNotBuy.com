import type { FiniteNumber, Reason3 } from '../../types/margin-assessment.js';

/** Independent S3-04 kernel for generic-linear-isolated@1; no financial formulas.
 *
 * Resource policy (part of stage3-rational@1): each supplied bigint and each
 * reduced numerator/denominator has at most 4096 magnitude bits. Inputs are
 * checked BEFORE GCD, even if an oversized pair could reduce to a small value.
 * Each operation uses at most two 4096-bit operands per multiplication; an
 * addition/subtraction has at most 8193 scratch bits. One Euclidean GCD has at
 * most 20,000 remainder steps (also guarded explicitly). Its operands decrease;
 * the worst 8193-bit Fibonacci pair needs fewer than 12,000 steps. Comparison
 * uses two <=8192-bit products. Publication uses <=5170-bit shifted integers,
 * one division and one remainder. There are no configurable shifts or loops.
 * Thus work/memory PER CALL are bounded, including results rejected after GCD.
 * The caller owns expression length and retained handles; there is no global
 * operation counter or retained strong-reference cache. No truncation occurs.
 * Changing these limits requires a new arithmetic version and identity context.
 */
export const STAGE3_ARITHMETIC_VERSION = 'stage3-rational@1' as const;
export const ARITHMETIC_LIMITS = Object.freeze({ componentBits: 4096, scratchBits: 8193, gcdSteps: 20_000 });

export type NumericErrorCode = Extract<Reason3,
    'NUMERIC_UNDERFLOW' | 'NUMERIC_OVERFLOW' | 'NUMERIC_RESOURCE_LIMIT' | 'CALCULATION_FAILED'>;
export type NumericResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: {
        readonly code: NumericErrorCode;
        readonly cause: 'underflow' | 'overflow' | 'resource_limit' | 'division_by_zero' | 'invalid_input' | 'untrusted_value';
    } };

declare const rationalBrand: unique symbol;
/** Opaque, module-issued value; never a published report value. */
export interface ExactRational { readonly [rationalBrand]: true }
export interface RationalParts { readonly numerator: bigint; readonly denominator: bigint }
const records = new WeakMap<ExactRational, RationalParts>();
const bound = 1n << BigInt(ARITHMETIC_LIMITS.componentBits);
const abs = (value: bigint): bigint => value < 0n ? -value : value;
const fits = (value: bigint): boolean => value > -bound && value < bound;
const success = <T>(value: T): NumericResult<T> => ({ ok: true, value });
const failure = (code: NumericErrorCode, cause: Extract<NumericResult<never>, { ok: false }>['error']['cause']): NumericResult<never> =>
    ({ ok: false, error: { code, cause } });
const resource = (): NumericResult<never> => failure('NUMERIC_RESOURCE_LIMIT', 'resource_limit');

/** Only called with checked inputs or bounded scratch products. */
function normalize(numerator: bigint, denominator: bigint): NumericResult<ExactRational> {
    if (denominator === 0n) return failure('CALCULATION_FAILED', 'division_by_zero');
    let n = denominator < 0n ? -numerator : numerator;
    let d = abs(denominator);
    let a = abs(n);
    let b = d;
    let steps = 0;
    while (b !== 0n) {
        if (steps >= ARITHMETIC_LIMITS.gcdSteps) return resource();
        const remainder = a % b;
        a = b;
        b = remainder;
        steps += 1;
    }
    n /= a;
    d /= a;
    if (!fits(n) || !fits(d)) return resource();
    const handle = Object.freeze({}) as ExactRational;
    records.set(handle, Object.freeze({ numerator: n, denominator: d }));
    return success(handle);
}

/** Checks primitive types and size before any bigint arithmetic or coercion. */
export function rational(numerator: bigint, denominator: bigint = 1n): NumericResult<ExactRational> {
    if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') return failure('CALCULATION_FAILED', 'invalid_input');
    if (!fits(numerator) || !fits(denominator)) return resource();
    return normalize(numerator, denominator);
}

/** Decode the actual IEEE-754 bits; decimal text is never involved. */
export function fromBinary64(value: number): NumericResult<ExactRational> {
    if (typeof value !== 'number' || !Number.isFinite(value)) return failure('CALCULATION_FAILED', 'invalid_input');
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const encodedExponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const significand = encodedExponent === 0 ? fraction : (1n << 52n) | fraction;
    const exponent = encodedExponent === 0 ? -1074 : encodedExponent - 1075;
    const signed = value < 0 ? -significand : significand;
    return normalize(exponent >= 0 ? signed << BigInt(exponent) : signed,
        exponent >= 0 ? 1n : 1n << BigInt(-exponent));
}

/** Read-only exact inspection, with no conversion to number or issuance path. */
export function rationalParts(value: ExactRational): NumericResult<RationalParts> {
    const parts = records.get(value);
    return parts ? success(parts) : failure('CALCULATION_FAILED', 'untrusted_value');
}

type Operation = 'add' | 'subtract' | 'multiply' | 'divide';
function calculate(left: ExactRational, right: ExactRational, operation: Operation): NumericResult<ExactRational> {
    const a = rationalParts(left);
    if (!a.ok) return a;
    const b = rationalParts(right);
    if (!b.ok) return b;
    const { numerator: an, denominator: ad } = a.value;
    const { numerator: bn, denominator: bd } = b.value;
    switch (operation) {
        case 'add': return normalize(an * bd + bn * ad, ad * bd);
        case 'subtract': return normalize(an * bd - bn * ad, ad * bd);
        case 'multiply': return normalize(an * bn, ad * bd);
        case 'divide': return normalize(an * bd, ad * bn);
    }
}
export const add = (a: ExactRational, b: ExactRational): NumericResult<ExactRational> => calculate(a, b, 'add');
export const subtract = (a: ExactRational, b: ExactRational): NumericResult<ExactRational> => calculate(a, b, 'subtract');
export const multiply = (a: ExactRational, b: ExactRational): NumericResult<ExactRational> => calculate(a, b, 'multiply');
export const divide = (a: ExactRational, b: ExactRational): NumericResult<ExactRational> => calculate(a, b, 'divide');

export function compare(left: ExactRational, right: ExactRational): NumericResult<-1 | 0 | 1> {
    const a = rationalParts(left);
    if (!a.ok) return a;
    const b = rationalParts(right);
    if (!b.ok) return b;
    const l = a.value.numerator * b.value.denominator;
    const r = b.value.numerator * a.value.denominator;
    return success(l < r ? -1 : l > r ? 1 : 0);
}

export type ExactComparison = 'lt' | 'lte' | 'eq' | 'gt' | 'gte';
export function testRelation(a: ExactRational, b: ExactRational, relation: ExactComparison): NumericResult<boolean> {
    const order = compare(a, b);
    if (!order.ok) return order;
    switch (relation) {
        case 'lt': return success(order.value < 0);
        case 'lte': return success(order.value <= 0);
        case 'eq': return success(order.value === 0);
        case 'gt': return success(order.value > 0);
        case 'gte': return success(order.value >= 0);
        default: return failure('CALCULATION_FAILED', 'invalid_input');
    }
}

/** The sole FiniteNumber issuance boundary. Round once, nearest/ties-to-even.
 * Nonzero exact values rounding to zero are refused, including negative values.
 * "Representable" means finite after rounding, not exactly representable (1/3
 * is publishable). The overflow midpoint rounds to infinity and is refused.
 */
export function publish(value: ExactRational): NumericResult<FiniteNumber> {
    const parts = rationalParts(value);
    if (!parts.ok) return parts;
    const { numerator, denominator } = parts.value;
    let rounded = 0;
    if (numerator !== 0n) {
        const magnitude = abs(numerator);
        let exponent = magnitude.toString(2).length - denominator.toString(2).length;
        const atLeastPower = exponent >= 0
            ? magnitude >= denominator << BigInt(exponent)
            : magnitude << BigInt(-exponent) >= denominator;
        if (!atLeastPower) exponent -= 1;
        if (exponent > 1023) return failure('NUMERIC_OVERFLOW', 'overflow');
        if (exponent < -1075) return failure('NUMERIC_UNDERFLOW', 'underflow');
        const quantum = Math.max(exponent - 52, -1074);
        const n = quantum < 0 ? magnitude << BigInt(-quantum) : magnitude;
        const d = quantum > 0 ? denominator << BigInt(quantum) : denominator;
        let significand = n / d;
        const twiceRemainder = 2n * (n % d);
        if (twiceRemainder > d || (twiceRemainder === d && significand % 2n === 1n)) significand += 1n;
        // <=53 bits or the exact carry 2^53; reconstruction incurs no rounding
        // except the possible overflow, checked below. Quantum >= -1074.
        rounded = Number(significand) * 2 ** quantum;
        if (rounded === 0) return failure('NUMERIC_UNDERFLOW', 'underflow');
        if (numerator < 0n) rounded = -rounded;
    }
    if (!Number.isFinite(rounded)) return failure('NUMERIC_OVERFLOW', 'overflow');
    if (Object.is(rounded, -0)) return failure('CALCULATION_FAILED', 'invalid_input');
    return success(rounded as FiniteNumber);
}
