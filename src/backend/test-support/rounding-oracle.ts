/**
 * Independent rounding oracle for the exact-rounding regression suites.
 *
 * Answers "what is the correctly rounded binary64 value of this exact binary
 * rational" by midpoint comparison over BigInt. The algorithm shares nothing
 * with the production helpers under test: no significand truncation like
 * `finiteProduct`, no shift-and-remainder with carry like `roundExact`. A
 * missing result means no binary64 represents the rounded value — a nonzero
 * value that underflows to zero (the tie included, which belongs to the even
 * zero), or an overflow past `MAX_VALUE`. Only tests import this module.
 */

export interface DecodedDouble {
    /** Exact integer significand: value = significand * 2**exponent. */
    readonly significand: bigint;
    readonly exponent: number;
}

/** Exact non-negative rational numerator / denominator, denominator > 0. */
export interface ExactRatio {
    readonly numerator: bigint;
    readonly denominator: bigint;
}

export type RoundedOracle =
    | { readonly available: true; readonly value: number }
    | { readonly available: false };

/** Decodes the actual binary64 bits, without decimal reinterpretation. */
export function decodeBinary64(value: number): DecodedDouble {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError('the oracle decodes finite non-negative numbers only');
    }

    if (value === 0) return { significand: 0n, exponent: 0 };

    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const pattern = view.getBigUint64(0);
    const encodedExponent = Number((pattern >> 52n) & 0x7ffn);
    const fraction = pattern & ((1n << 52n) - 1n);

    return {
        significand: encodedExponent === 0 ? fraction : (1n << 52n) | fraction,
        exponent: encodedExponent === 0 ? -1074 : encodedExponent - 1023 - 52,
    };
}

/** Exact product of two decoded doubles. */
export function exactProduct(a: DecodedDouble, b: DecodedDouble): ExactRatio {
    const exponent = a.exponent + b.exponent;

    return exponent >= 0
        ? {
            numerator: a.significand * b.significand << BigInt(exponent),
            denominator: 1n,
        }
        : {
            numerator: a.significand * b.significand,
            denominator: 1n << BigInt(-exponent),
        };
}

/** Exact quotient of a ratio by a decoded double with a positive significand. */
export function dividedByDouble(ratio: ExactRatio, b: DecodedDouble): ExactRatio {
    if (b.significand <= 0n) {
        throw new RangeError('the oracle divides by a positive double only');
    }

    return b.exponent >= 0
        ? {
            numerator: ratio.numerator,
            denominator: ratio.denominator * b.significand << BigInt(b.exponent),
        }
        : {
            numerator: ratio.numerator << BigInt(-b.exponent),
            denominator: ratio.denominator * b.significand,
        };
}

const sign = (value: bigint): number => (value < 0n ? -1 : value > 0n ? 1 : 0);

/** Rounds once, nearest/ties-to-even, to the nearest binary64. */
export function roundedBinary64(ratio: ExactRatio): RoundedOracle {
    if (ratio.denominator <= 0n) {
        throw new RangeError('the oracle denominator must be positive');
    }

    if (ratio.numerator === 0n) return { available: true, value: 0 };
    if (ratio.numerator < 0n) {
        throw new RangeError('the oracle covers non-negative values only');
    }

    // Binary exponent E with 2^E <= value < 2^(E+1), by exact comparison;
    // the bit-length estimate is off by at most one, the loops repair it.
    const atLeast = (power: number): boolean => (power >= 0
        ? ratio.numerator >= (ratio.denominator << BigInt(power))
        : (ratio.numerator << BigInt(-power)) >= ratio.denominator);
    let exponent = ratio.numerator.toString(2).length - ratio.denominator.toString(2).length;
    while (!atLeast(exponent)) exponent -= 1;
    while (atLeast(exponent + 1)) exponent += 1;

    // The quantum of the target range: normals space at 2^(E-52), the
    // subnormals at 2^-1074.
    const quantum = exponent >= -1022 ? exponent - 52 : -1074;

    // Floor of value / quantum, exact.
    const floorUnits = quantum >= 0
        ? ratio.numerator / (ratio.denominator << BigInt(quantum))
        : (ratio.numerator << BigInt(-quantum)) / ratio.denominator;

    // Exact comparison against the midpoint (floorUnits + 1/2) quanta.
    const twiceNumerator = ratio.numerator << 1n;
    const twiceCandidate = (floorUnits << 1n) + 1n;
    const atMidpoint = quantum >= 0
        ? sign(twiceNumerator - ratio.denominator * (twiceCandidate << BigInt(quantum)))
        : sign((twiceNumerator << BigInt(-quantum)) - ratio.denominator * twiceCandidate);

    // On an exact tie the even significand wins; in quantum units the
    // significand is the units count for subnormals and normals alike.
    const units = atMidpoint > 0
        ? floorUnits + 1n
        : atMidpoint < 0
        ? floorUnits
        : floorUnits % 2n === 0n
        ? floorUnits
        : floorUnits + 1n;

    const rounded = Number(units) * 2 ** quantum;
    if (rounded === 0 || !Number.isFinite(rounded)) return { available: false };

    return { available: true, value: rounded };
}
