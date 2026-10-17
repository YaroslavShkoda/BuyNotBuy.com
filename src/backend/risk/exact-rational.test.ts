import { describe, expect, it } from 'vitest';
import { exactDivide, exactMultiply, exactNumber, exactSubtract, roundExact } from './exact-rational.js';
import { finiteProduct } from './finite-product.js';

const failure = { value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' };
const add = (a: number, b: number) => exactSubtract(exactNumber(a), exactNumber(-b));

describe('exact binary64 rational arithmetic', () => {
    it.each([0, -0, 1, -1, 0.1, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** -1022, Number.MAX_VALUE])('round-trips %s exactly', (value) => {
        expect(roundExact(exactNumber(value))).toEqual({ value: value === 0 ? 0 : value, status: 'valid', reasonCode: null });
    });

    it('subtracts without reciprocal cancellation and divides signed fractions', () => {
        expect(roundExact(exactSubtract(exactNumber(1 + Number.EPSILON), exactNumber(1))).value).toBe(Number.EPSILON);
        expect(roundExact(exactDivide(exactNumber(-1), exactNumber(3))).value).toBe(-1 / 3);
        expect(roundExact(exactDivide(exactNumber(-1), exactNumber(-3))).value).toBe(1 / 3);
        expect(roundExact(exactSubtract(exactNumber(Number.MIN_VALUE), exactNumber(Number.MIN_VALUE))).value).toBe(0);
    });

    it('rounds exact normal halfway values to even, including a carry', () => {
        expect(roundExact(add(1, 2 ** -53)).value).toBe(1);
        expect(roundExact(add(1, 3 * 2 ** -53)).value).toBe(1 + 2 * Number.EPSILON);
        expect(roundExact(add(2, -(2 ** -53))).value).toBe(2);
        expect(roundExact(add(-1, -(2 ** -53))).value).toBe(-1);
    });

    it('rounds subnormals once, handles the normal boundary and never publishes a false zero', () => {
        expect(roundExact(exactMultiply(exactNumber(Number.MIN_VALUE), exactNumber(0.5)))).toEqual(failure);
        expect(roundExact(exactMultiply(exactNumber(Number.MIN_VALUE), exactNumber(0.75))).value).toBe(Number.MIN_VALUE);
        expect(roundExact(exactMultiply(exactNumber(Number.MIN_VALUE), exactNumber(1.5))).value).toBe(2 * Number.MIN_VALUE);
        expect(roundExact(exactMultiply(exactNumber(Number.MIN_VALUE), exactNumber(-2.5))).value).toBe(-2 * Number.MIN_VALUE);
        expect(roundExact(exactSubtract(exactNumber(2 ** -1022), exactDivide(exactNumber(Number.MIN_VALUE), exactNumber(2)))).value).toBe(2 ** -1022);
        expect(roundExact(exactDivide(exactNumber(Number.MIN_VALUE), exactNumber(Number.MAX_VALUE)))).toEqual(failure);
    });

    it('detects final overflow at the rounding midpoint and preserves values below it', () => {
        expect(roundExact(add(Number.MAX_VALUE, 2 ** 969)).value).toBe(Number.MAX_VALUE);
        expect(roundExact(add(Number.MAX_VALUE, 2 ** 970))).toEqual(failure);
        expect(roundExact(add(-Number.MAX_VALUE, -(2 ** 970)))).toEqual(failure);
        expect(roundExact(exactMultiply(exactNumber(Number.MAX_VALUE), exactNumber(2)))).toEqual(failure);
    });

    it('agrees with the unchanged finiteProduct on products', () => {
        for (const [a, b, c] of [[1e200, 1e-200, 1e-200], [1e308, 1e-323, 0.01], [-1.5, 4 / 3, 1], [0, Number.MAX_VALUE, Number.MAX_VALUE]]) {
            expect(roundExact(exactMultiply(exactMultiply(exactNumber(a!), exactNumber(b!)), exactNumber(c!)))).toEqual(finiteProduct(a!, b!, c!));
        }
    });

    it('rejects undefined arithmetic at the internal boundary', () => {
        for (const value of [NaN, Infinity, -Infinity]) expect(() => exactNumber(value)).toThrow(RangeError);
        expect(() => exactDivide(exactNumber(1), exactNumber(0))).toThrow(RangeError);
    });
});
