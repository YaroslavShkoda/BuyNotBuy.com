import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { finiteProduct } from './finite-product.js';

const failure = {
    value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
};

describe('finiteProduct', () => {
    it.each([
        [1e-200, 1e-200, 1e200, 1e-200],
        [0.01, 1e-323, 1e308, 9.881312916824931e-18],
        [0.01, 2e108, 1e200, 2e306],
        [1e-160, 1e-160, 1e160, 1e-160],
    ])('preserves a representable product for %s, %s, %s', (a, b, c, expected) => {
        // Decimal expectations derived on paper, including the actual binary64
        // value of 1e-323 = 2 * Number.MIN_VALUE in the second case.
        for (const [x, y, z] of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
            const result = finiteProduct(x!, y!, z!);
            expect(result.status).toBe('valid');
            expect(result.value! / expected).toBeCloseTo(1, 14);
        }
    });

    it('preserves sign without losing a small negative funding payment', () => {
        expect(finiteProduct(-1e-200, 1e-200, 1e200).value! / -1e-200).toBeCloseTo(1, 14);
        expect(finiteProduct(-1e-200, -1e-200, 1e200).value! / 1e-200).toBeCloseTo(1, 14);
    });

    it('distinguishes an actual zero factor from a product rounded to zero', () => {
        expect(finiteProduct(0, Number.MAX_VALUE, Number.MIN_VALUE)).toEqual({
            value: 0, status: 'valid', reasonCode: null,
        });
        expect(finiteProduct(-0, -Number.MAX_VALUE, Number.MAX_VALUE).value).toBe(0);
        expect(finiteProduct(Number.MIN_VALUE, 0.5, 1)).toEqual(failure);
        expect(finiteProduct(Number.MIN_VALUE, 0.25, 1)).toEqual(failure);
    });

    it('rounds normal and subnormal halfway cases to even exactly once', () => {
        expect(finiteProduct(1 + Number.EPSILON, 1.5, 1).value).toBe(1.5 + 2 * Number.EPSILON);
        expect(finiteProduct(1 + 2 * Number.EPSILON, 1.25, 1).value).toBe(1.25 + 2 * Number.EPSILON);
        expect(finiteProduct(Number.MIN_VALUE, 0.75, 1).value).toBe(Number.MIN_VALUE);
        expect(finiteProduct(Number.MIN_VALUE, 1.5, 1).value).toBe(2 * Number.MIN_VALUE);
        expect(finiteProduct(Number.MIN_VALUE, 2.5, 1).value).toBe(2 * Number.MIN_VALUE);
        expect(finiteProduct(Number.MIN_VALUE, -3.5, 1).value).toBe(-4 * Number.MIN_VALUE);
        const minNormal = 2 ** -1022;
        expect(finiteProduct(minNormal, 1 - Number.EPSILON / 2, 1).value).toBe(minNormal);
        expect(finiteProduct(minNormal, 1 - Number.EPSILON, 1).value).toBe(minNormal - Number.MIN_VALUE);
    });

    it('reports final overflow and rejects non-finite factors even alongside zero', () => {
        expect(finiteProduct(Number.MAX_VALUE, 1, 1).value).toBe(Number.MAX_VALUE);
        expect(finiteProduct(Number.MAX_VALUE, 2, 1)).toEqual(failure);
        expect(finiteProduct(-Number.MAX_VALUE, 2, 1)).toEqual(failure);
        for (const value of [Infinity, -Infinity, NaN]) {
            expect(finiteProduct(value, 0, 1)).toEqual(failure);
        }
    });

    it('matches an independent exponent-sum oracle over the binary64 range', () => {
        fc.assert(fc.property(
            fc.integer({ min: -1074, max: 1023 }),
            fc.integer({ min: -1074, max: 1023 }),
            fc.integer({ min: -1074, max: 1023 }),
            fc.constantFrom(-1, 1),
            fc.constantFrom(-1, 1),
            fc.constantFrom(-1, 1),
            (a, b, c, signA, signB, signC) => {
                // Powers of two are exact inputs; this oracle uses exponent
                // addition and native exponentiation, not significand arithmetic.
                const magnitude = 2 ** (a + b + c);
                const expected = signA * signB * signC * magnitude;
                for (const factors of [
                    [signA * 2 ** a, signB * 2 ** b, signC * 2 ** c],
                    [signC * 2 ** c, signA * 2 ** a, signB * 2 ** b],
                ]) {
                    const result = finiteProduct(factors[0]!, factors[1]!, factors[2]!);
                    if (magnitude === 0 || !Number.isFinite(magnitude)) {
                        expect(result).toEqual(failure);
                    } else {
                        expect(result).toEqual({ value: expected, status: 'valid', reasonCode: null });
                    }
                }
            },
        ), { numRuns: 2000, examples: [
            [1000, 1000, -1000, 1, 1, 1],
            [-1000, -1000, 1000, -1, 1, 1],
            [-1074, 1023, -500, 1, -1, -1],
        ] });
    });

    it('matches a normalized reference for varied significands despite overflowing or vanishing pairs', () => {
        const mantissa = fc.double({ min: 1, max: 2 - Number.EPSILON, noNaN: true });
        fc.assert(fc.property(
            mantissa, mantissa, mantissa,
            fc.integer({ min: -1000, max: 1000 }),
            fc.integer({ min: -1000, max: 1000 }),
            fc.integer({ min: -1000, max: 1000 }),
            fc.constantFrom(-1, 1),
            (a, b, c, exponentA, exponentB, totalExponent, sign) => {
                const exponentC = totalExponent - exponentA - exponentB;
                fc.pre(exponentC >= -1000 && exponentC <= 1000);
                // All generated inputs and the answer are normal numbers.
                // The oracle multiplies bounded mantissas in [1, 2), then
                // scales once by a known exponent; no hazardous pair is formed.
                // Allow its two ordinary multiplications a few rounding ulps;
                // exact halfway behavior is asserted separately above.
                const expected = sign * ((a * b) * c) * 2 ** totalExponent;
                const result = finiteProduct(
                    sign * a * 2 ** exponentA, b * 2 ** exponentB, c * 2 ** exponentC,
                );
                expect(result.status).toBe('valid');
                expect(Math.abs((result.value! - expected) / expected)).toBeLessThanOrEqual(4 * Number.EPSILON);
            },
        ), { numRuns: 2000 });
    });
});
