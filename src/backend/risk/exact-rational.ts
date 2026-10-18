/** Internal exact value: numerator / denominator * 2^exponent; denominator > 0. */
export interface ExactRational {
    readonly numerator: bigint;
    readonly denominator: bigint;
    readonly exponent: number;
}

/** Decode the actual binary64 bits, without decimal reinterpretation. */
export function exactNumber(value: number): ExactRational {
    if (!Number.isFinite(value)) throw new RangeError('exactNumber requires a finite number');
    if (value === 0) return { numerator: 0n, denominator: 1n, exponent: 0 };
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const encodedExponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const significand = encodedExponent === 0 ? fraction : (1n << 52n) | fraction;
    return {
        numerator: value < 0 ? -significand : significand,
        denominator: 1n,
        exponent: encodedExponent === 0 ? -1074 : encodedExponent - 1023 - 52,
    };
}

export function exactMultiply(a: ExactRational, b: ExactRational): ExactRational {
    return {
        numerator: a.numerator * b.numerator,
        denominator: a.denominator * b.denominator,
        exponent: a.exponent + b.exponent,
    };
}

export function exactSubtract(a: ExactRational, b: ExactRational): ExactRational {
    const exponent = Math.min(a.exponent, b.exponent);
    return {
        numerator: (a.numerator * b.denominator << BigInt(a.exponent - exponent))
            - (b.numerator * a.denominator << BigInt(b.exponent - exponent)),
        denominator: a.denominator * b.denominator,
        exponent,
    };
}

export function exactAdd(a: ExactRational, b: ExactRational): ExactRational {
    return exactSubtract(a, { ...b, numerator: -b.numerator });
}

export function exactDivide(a: ExactRational, b: ExactRational): ExactRational {
    if (b.numerator === 0n) throw new RangeError('exact division by zero');
    const sign = b.numerator < 0n ? -1n : 1n;
    return {
        numerator: sign * a.numerator * b.denominator,
        denominator: sign * a.denominator * b.numerator,
        exponent: a.exponent - b.exponent,
    };
}

/** Round once, nearest/ties-to-even, including the subnormal quantum 2^-1074. */
export function roundExact(value: ExactRational) {
    const failure = { value: null, status: 'calculation_error' as const, reasonCode: 'CALCULATION_OVERFLOW' as const };
    const valid = (number: number) => ({ value: number, status: 'valid' as const, reasonCode: null });
    if (value.denominator <= 0n) throw new RangeError('exact denominator must be positive');
    if (value.numerator === 0n) return valid(0);
    const magnitude = value.numerator < 0n ? -value.numerator : value.numerator;
    const denominator = value.denominator;
    let binaryExponent = magnitude.toString(2).length - denominator.toString(2).length;
    const atLeastPower = binaryExponent >= 0
        ? magnitude >= denominator << BigInt(binaryExponent)
        : magnitude << BigInt(-binaryExponent) >= denominator;
    if (!atLeastPower) binaryExponent -= 1;
    binaryExponent += value.exponent;
    if (binaryExponent > 1023 || binaryExponent < -1075) return failure;

    const quantum = Math.max(binaryExponent - 52, -1074);
    const shift = value.exponent - quantum;
    const numerator = shift >= 0 ? magnitude << BigInt(shift) : magnitude;
    const divisor = shift >= 0 ? denominator : denominator << BigInt(-shift);
    let significand = numerator / divisor;
    const remainder = numerator % divisor;
    if (2n * remainder > divisor || (2n * remainder === divisor && (significand & 1n) === 1n)) {
        significand += 1n;
    }
    // The rounded integer has <=53 bits (or the exact carry 2^53), and the
    // quantum is representable. Reconstruction is exact unless it overflows.
    const rounded = Number(significand) * 2 ** quantum;
    if (rounded === 0 || !Number.isFinite(rounded)) return failure;
    return valid(value.numerator < 0n ? -rounded : rounded);
}
