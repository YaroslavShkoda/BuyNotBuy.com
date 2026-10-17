import type { MathValue } from './position-math.js';

/**
 * Product of three finite binary64 inputs, rounded once, ties to even.
 *
 * Reordering floating-point multiplications cannot protect both ends of the
 * exponent range. Instead, multiply the exact integer significands (at most
 * 159 bits in total) and add their binary exponents. Only the final result is
 * rounded to binary64, including its subnormal range. No dependency or decimal
 * reinterpretation of the input is involved.
 *
 * An actual zero factor gives zero. A nonzero product that rounds to zero, or
 * overflows to infinity, is unavailable under the existing arithmetic-error
 * contract; it must not masquerade as a valid zero or a clamped value.
 */
export function finiteProduct(a: number, b: number, c: number): MathValue {
    const factors = [a, b, c];
    const failed: MathValue = {
        value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
    };

    if (factors.some((factor) => !Number.isFinite(factor))) {
        return failed;
    }
    if (factors.some((factor) => factor === 0)) {
        return { value: 0, status: 'valid', reasonCode: null };
    }

    const view = new DataView(new ArrayBuffer(8));
    const fractionMask = (1n << 52n) - 1n;
    let significand = 1n;
    let exponent = 0;
    let negative = false;

    for (const factor of factors) {
        view.setFloat64(0, factor);
        const bits = view.getBigUint64(0);
        const encodedExponent = Number((bits >> 52n) & 0x7ffn);
        const fraction = bits & fractionMask;
        negative = negative !== (factor < 0);
        significand *= encodedExponent === 0 ? fraction : (1n << 52n) | fraction;
        exponent += encodedExponent === 0 ? -1074 : encodedExponent - 1023 - 52;
    }

    // Retain at most 53 significant bits, and never use a quantum smaller
    // than 2^-1074 (the least positive Number). Both constraints are applied
    // together so the subnormal boundary is rounded only once.
    const discardedBits = Math.max(0, significand.toString(2).length - 53, -1074 - exponent);
    if (discardedBits > 0) {
        const shift = BigInt(discardedBits);
        const retained = significand >> shift;
        const remainder = significand - (retained << shift);
        const halfway = 1n << (shift - 1n);
        const roundUp = remainder > halfway || (remainder === halfway && (retained & 1n) === 1n);
        significand = retained + (roundUp ? 1n : 0n);
        exponent += discardedBits;
    }

    const magnitude = Number(significand) * 2 ** exponent;
    if (!Number.isFinite(magnitude) || magnitude === 0) {
        return failed;
    }
    return { value: negative ? -magnitude : magnitude, status: 'valid', reasonCode: null };
}
