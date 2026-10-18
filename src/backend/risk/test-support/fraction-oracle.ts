// Independent oracle: decode via binary strings into ordinary fractions.
// Find the two adjacent binary64 values by binary search across bit patterns,
// then compare exact distances. No production decoding, exponent selection,
// significand truncation or rounding helper is used here.
export interface Fraction { n: bigint; d: bigint }
export const fromNumber = (value: number): Fraction => {
    const [integer = '0', decimals = ''] = Math.abs(value).toString(2).split('.');
    return { n: (value < 0 ? -1n : 1n) * BigInt(`0b${integer}${decimals}`), d: 1n << BigInt(decimals.length) };
};
export const add = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
export const sub = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
export const mul = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.n, d: a.d * b.d });
export const div = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d, d: a.d * b.n });
export const cmp = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
export const failure = { value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' } as const;
const view = new DataView(new ArrayBuffer(8));
function fromBits(bits: bigint): number {
    view.setBigUint64(0, bits);
    return view.getFloat64(0);
}
const maxBits = 0x7fefffffffffffffn;
const overflowMidpoint = add(fromNumber(Number.MAX_VALUE), fromNumber(2 ** 970));
export function rounded(value: Fraction) {
    if (value.n === 0n) return { value: 0, status: 'valid', reasonCode: null } as const;
    const magnitude = { ...value, n: value.n < 0n ? -value.n : value.n };
    if (cmp(magnitude, overflowMidpoint) >= 0n) return failure;
    let low = 0n;
    let high = maxBits;
    while (low < high) {
        const middle = (low + high + 1n) / 2n;
        if (cmp(fromNumber(fromBits(middle)), magnitude) <= 0n) low = middle;
        else high = middle - 1n;
    }
    if (low < maxBits) {
        const down = sub(magnitude, fromNumber(fromBits(low)));
        const up = sub(fromNumber(fromBits(low + 1n)), magnitude);
        const distance = cmp(down, up);
        if (distance > 0n || (distance === 0n && low % 2n === 1n)) low += 1n;
    }
    return low === 0n ? failure : {
        value: (value.n < 0n ? -1 : 1) * fromBits(low), status: 'valid', reasonCode: null,
    } as const;
}
