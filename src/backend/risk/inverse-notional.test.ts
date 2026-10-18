import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeBinary64, exactProduct, roundedBinary64 } from '../test-support/rounding-oracle.js';
import { allMetrics, inversePerpInput } from './fixtures.js';
import { absoluteNotionalQuote, type PositionSpec } from './position-math.js';
import { buildRiskReport } from './report.js';
import { RiskInputSchema } from './schema.js';

function inverse(qtyBase: number, contractSizeUsd: number, notionalQuote: number) {
    const base = inversePerpInput();
    return inversePerpInput({
        qtyBase, contractSizeUsd, notionalQuote, marginCurrency: 'base',
        entryPrice: 1, currentPrice: 1, exitPriceQuote: 1,
        margin: { mode: 'isolated', rules: null },
        costs: { ...base.costs, fundingRatePerInterval: 0.5 },
    });
}

function refused(qty: number, size: number, notional: number) {
    const input = inverse(qty, size, notional);
    const result = RiskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join('.') === 'notionalQuote')).toBe(true);
    }
    expect(() => buildRiskReport(input)).toThrow();
}

function inverseSpec(qtyBase: number, contractSizeUsd: number): PositionSpec {
    return {
        contractKind: 'inverse_perp',
        side: 'LONG',
        qtyBase,
        entryPrice: 1,
        contractSizeUsd,
        marginCurrency: 'base',
    };
}

describe('inverse notional relative validation', () => {
    it.each([
        [1, 1e-12, 1e-10],
        [1, 1e-20, 1e-10],
        [1, Number.MIN_VALUE, 2 * Number.MIN_VALUE],
        [1, 1e300, 1.01e300],
        [Number.MAX_VALUE, 2, Number.MAX_VALUE],
        [Number.MIN_VALUE, 0.5, Number.MIN_VALUE],
        [1e-200, 1e-200, 1e-300],
    ])('refuses inconsistent or unrepresentable %s x %s against %s', refused);

    it.each([
        [1, 1e-12, 1e-12],
        [0.1, 0.2, 0.02],
        [1, Number.MIN_VALUE, Number.MIN_VALUE],
        [Number.MIN_VALUE, 0.75, Number.MIN_VALUE],
        [Number.MAX_VALUE, 1, Number.MAX_VALUE],
        [1e200, 1e-200, 1],
        [1e308, 1e-323, 9.881312916824931e-16],
        [1, 1e-300, 1.0000005e-300],
        [1, 1e300, 1.0000005e300],
    ])('accepts rounded or tolerance-compatible %s x %s against %s', (qty, size, notional) => {
        expect(RiskInputSchema.safeParse(inverse(qty, size, notional)).success).toBe(true);
    });

    it('keeps validated nominal and signed funding coherent through JSON', () => {
        for (const side of ['LONG', 'SHORT'] as const) {
            const input = inverse(100, 10, 1000);
            const raw = buildRiskReport({ ...input, side, costs: { ...input.costs, fundingRatePerInterval: 0.001 } });
            const json = JSON.stringify(raw, (_key, value: unknown) => {
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            });
            for (const report of [raw, JSON.parse(json) as typeof raw]) {
                const metrics = new Map(allMetrics(report).map((block) => [block.metricKey, block]));
                expect(metrics.get('entryNotionalQuote')).toMatchObject({ value: 1000, status: 'valid', unit: 'quote_currency' });
                expect(metrics.get('holdingCostPerIntervalQuote')).toMatchObject({ value: side === 'LONG' ? 1 : -1, status: 'valid', unit: 'quote_currency' });
                expect(report.reportStatus).toBe('insufficient_data');
                expect(report.marginViolation.detected).toBeNull();
            }
        }
    });

    it('preserves missing-size completeness handling', () => {
        const input = { ...inverse(1, 1, 1e-10), contractSizeUsd: null };
        expect(RiskInputSchema.safeParse(input).success).toBe(true);
        const report = buildRiskReport(input);
        expect(allMetrics(report).find((block) => block.metricKey === 'holdingCostPerIntervalQuote'))
            .toMatchObject({ value: null, status: 'insufficient_data', reasonCode: 'MISSING_INVERSE_CONTRACT_PARAMS' });
    });
});

describe('inverse notional properties with analytic binary oracles', () => {
    it('checks the complete binary exponent range without accepting rounded-zero or infinite products', () => {
        fc.assert(fc.property(
            fc.integer({ min: -1074, max: 1023 }),
            fc.integer({ min: -1074, max: 1023 }),
            (qtyExponent, sizeExponent) => {
                // Powers of two have an exact product 2^(a+b). In particular,
                // 2^-1075 is a tie rounded to zero; 2^1024 overflows.
                const exponent = qtyExponent + sizeExponent;
                const representable = exponent >= -1074 && exponent <= 1023;
                const notional = 2 ** Math.max(-1074, Math.min(1023, exponent));
                const input = inverse(2 ** qtyExponent, 2 ** sizeExponent, notional);
                expect(RiskInputSchema.safeParse(input).success).toBe(representable);
                if (representable) {
                    refused(input.qtyBase, input.contractSizeUsd!, notional * 2);
                }
            },
        ), { seed: 222201, numRuns: 2000, examples: [[-1074, -1], [-1074, 0], [1023, 1], [1023, 0], [-1000, 1000]] });
    });

    it('preserves rounding tolerance and funding for independently multiplied integer significands', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 1023 }), fc.integer({ min: 1, max: 1023 }),
            fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 }),
            fc.constantFrom('LONG', 'SHORT'),
            (a, b, qtyExponent, sizeExponent, side) => {
                // a*b is an exact <=20-bit integer; binary scaling is exact
                // throughout this range. The oracle never calls finiteProduct.
                const notional = (a * b) * 2 ** (qtyExponent + sizeExponent);
                const input = inverse(a * 2 ** qtyExponent, b * 2 ** sizeExponent, notional);
                expect(RiskInputSchema.safeParse(input).success).toBe(true);
                for (const factor of [1 - 5e-7, 1 + 5e-7]) {
                    expect(RiskInputSchema.safeParse({ ...input, notionalQuote: notional * factor }).success).toBe(true);
                }
                refused(input.qtyBase, input.contractSizeUsd!, notional * 1.01);
                const raw = buildRiskReport({ ...input, side });
                for (const report of [raw, JSON.parse(JSON.stringify(raw)) as typeof raw]) {
                    const metrics = new Map(allMetrics(report).map((block) => [block.metricKey, block]));
                    expect(metrics.get('entryNotionalQuote')).toMatchObject({ value: notional, status: 'valid' });
                    expect(metrics.get('holdingCostPerIntervalQuote')).toMatchObject({ value: (side === 'LONG' ? 1 : -1) * (a * b) * 2 ** (qtyExponent + sizeExponent - 1), status: 'valid' });
                    expect(report.reportStatus).toBe('insufficient_data');
                    expect(report.marginViolation.detected).toBeNull();
                }
            },
        ), { seed: 222202, numRuns: 1000 });
    });
});

describe('inverse notional exact rounding at the function boundary', () => {
    it('publishes no valid zero for a nonzero product that rounds to zero', () => {
        expect(absoluteNotionalQuote(inverseSpec(Number.MIN_VALUE, 0.5))).toEqual({
            value: null,
            status: 'calculation_error',
            reasonCode: 'CALCULATION_OVERFLOW',
        });
        expect(absoluteNotionalQuote(inverseSpec(Number.MIN_VALUE, 0.25)).status).toBe(
            'calculation_error',
        );
    });

    it('rounds the subnormal ties once, nearest with ties to even', () => {
        expect(absoluteNotionalQuote(inverseSpec(Number.MIN_VALUE, 0.75))).toEqual({
            value: Number.MIN_VALUE,
            status: 'valid',
            reasonCode: null,
        });
        // 1.5 quanta: the odd tie rounds up to the even quantum 2.
        expect(absoluteNotionalQuote(inverseSpec(Number.MIN_VALUE, 1.5))).toEqual({
            value: 2 * Number.MIN_VALUE,
            status: 'valid',
            reasonCode: null,
        });
        // 2.5 quanta: the even tie stays at two quanta.
        expect(absoluteNotionalQuote(inverseSpec(Number.MIN_VALUE, 2.5))).toEqual({
            value: 2 * Number.MIN_VALUE,
            status: 'valid',
            reasonCode: null,
        });
    });

    it('rounds the largest subnormal against the normal boundary once', () => {
        const largestSubnormal = (2 ** 53 - 1) * Number.MIN_VALUE;
        // The exact product is 3 x (2^53 - 1) quanta of 2^-1074; the nearest
        // double keeps it as (3 x 2^51 - 1) quanta of 2^-1072.
        expect(absoluteNotionalQuote(inverseSpec(largestSubnormal, 3))).toEqual({
            value: (3 * 2 ** 51 - 1) * 2 ** -1072,
            status: 'valid',
            reasonCode: null,
        });
    });

    it('answers calculation_error when the product overflows, valid at the edge', () => {
        expect(absoluteNotionalQuote(inverseSpec(Number.MAX_VALUE, 2))).toEqual({
            value: null,
            status: 'calculation_error',
            reasonCode: 'CALCULATION_OVERFLOW',
        });
        expect(absoluteNotionalQuote(inverseSpec(Number.MAX_VALUE, 1))).toEqual({
            value: Number.MAX_VALUE,
            status: 'valid',
            reasonCode: null,
        });
        // Single rounding: the published figure is the nearest double to the
        // exact product, not a twice-rounded chain.
        expect(absoluteNotionalQuote(inverseSpec(1e308, 1e-323))).toEqual({
            value: 9.881312916824931e-16,
            status: 'valid',
            reasonCode: null,
        });
    });

    it('keeps the zero guard: a true zero input cannot reach the gate', () => {
        for (const zero of [0, -0]) {
            expect(() => absoluteNotionalQuote(inverseSpec(zero, 1))).toThrow(RangeError);
            expect(() => absoluteNotionalQuote(inverseSpec(1, zero))).toThrow(RangeError);
        }
        // The `0 / valid` publication contract itself lives where a zero can
        // exist: exact-rational.test.ts (a zero numerator rounds to a valid
        // zero) and the finiteProduct zero-factor suite.
    });

    it('preserves ordinary linear notional and its overflow status', () => {
        expect(absoluteNotionalQuote({
            contractKind: 'linear_perp',
            side: 'LONG',
            qtyBase: 0.5,
            entryPrice: 40000,
            contractSizeUsd: null,
            marginCurrency: null,
        })).toEqual({ value: 20000, status: 'valid', reasonCode: null });
        expect(absoluteNotionalQuote({
            contractKind: 'linear_perp',
            side: 'SHORT',
            qtyBase: Number.MAX_VALUE,
            entryPrice: 2,
            contractSizeUsd: null,
            marginCurrency: null,
        }).status).toBe('calculation_error');
    });

    it('matches the midpoint oracle over random significands and exponents', () => {
        fc.assert(fc.property(
            fc.bigInt({ min: 1n, max: (1n << 53n) - 1n }),
            fc.bigInt({ min: 1n, max: (1n << 53n) - 1n }),
            fc.integer({ min: -1074, max: 970 }),
            fc.integer({ min: -1074, max: 970 }),
            (qtySignificand, sizeSignificand, qtyExponent, sizeExponent) => {
                const qty = Number(qtySignificand) * 2 ** qtyExponent;
                const size = Number(sizeSignificand) * 2 ** sizeExponent;
                const math = absoluteNotionalQuote(inverseSpec(qty, size));
                const oracle = roundedBinary64(
                    exactProduct(decodeBinary64(qty), decodeBinary64(size)),
                );
                if (oracle.available) {
                    expect(math).toEqual({ value: oracle.value, status: 'valid', reasonCode: null });
                } else {
                    expect(math).toEqual({
                        value: null,
                        status: 'calculation_error',
                        reasonCode: 'CALCULATION_OVERFLOW',
                    });
                }
                // One binary64 multiplication rounds the exact product once,
                // exactly like the metric must: whenever it lands on a real
                // number, that number is the published value.
                const naive = qty * size;
                if (Number.isFinite(naive) && naive !== 0) {
                    expect(math.value).toBe(naive);
                }
            },
        ), { seed: 224001, numRuns: 1500 });
    });
});
