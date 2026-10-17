import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    decodeBinary64,
    dividedByDouble,
    exactProduct,
    roundedBinary64,
} from '../test-support/rounding-oracle.js';
import { allMetrics, inversePerpInput } from './fixtures.js';
import {
    absoluteExposureBaseUnits,
    absoluteNotionalQuote,
    type PositionSpec,
} from './position-math.js';
import { buildRiskReport } from './report.js';
import { RiskInputSchema } from './schema.js';

const CALCULATION_OVERFLOW = {
    value: null,
    status: 'calculation_error',
    reasonCode: 'CALCULATION_OVERFLOW',
} as const;

function inverseSpec(
    qtyBase: number,
    contractSizeUsd: number,
    entryPrice: number,
): PositionSpec {
    return {
        contractKind: 'inverse_perp',
        side: 'LONG',
        qtyBase,
        entryPrice,
        contractSizeUsd,
        marginCurrency: 'base',
    };
}

describe('inverse exposure exact rounding at the function boundary', () => {
    it('publishes no valid zero for a nonzero exposure that rounds to zero', () => {
        // The audited reachable defect: a schema-accepted MIN_VALUE notional
        // divided by an entry near the top of the price range used to publish
        // a valid zero here.
        expect(absoluteExposureBaseUnits(inverseSpec(1, Number.MIN_VALUE, 1e308))).toEqual(
            CALCULATION_OVERFLOW,
        );
        expect(absoluteExposureBaseUnits(inverseSpec(1, 2 * Number.MIN_VALUE, 1e308))).toEqual(
            CALCULATION_OVERFLOW,
        );
    });

    it('resolves the subnormal tie by exact division, ties to even', () => {
        // Exact exposure 2^-52 / 2^1023 = 2^-1075: the tie between zero (the
        // even significand) and MIN_VALUE resolves to zero, so the answer is
        // unavailable rather than a false zero.
        expect(absoluteExposureBaseUnits(inverseSpec(1, 2 ** -52, 2 ** 1023))).toEqual(
            CALCULATION_OVERFLOW,
        );
        // Exact exposure 3 x 2^-1075 = 1.5 quanta: the odd tie rounds up to
        // the even quantum 2.
        expect(absoluteExposureBaseUnits(inverseSpec(1, 3 * 2 ** -52, 2 ** 1023))).toEqual({
            value: 2 * Number.MIN_VALUE,
            status: 'valid',
            reasonCode: null,
        });
    });

    it('rounds each metric once from its own exact value', () => {
        // Exposure representable while the notional overflows.
        const overflowNotional = inverseSpec(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
        expect(absoluteNotionalQuote(overflowNotional)).toEqual(CALCULATION_OVERFLOW);
        expect(absoluteExposureBaseUnits(overflowNotional)).toEqual({
            value: Number.MAX_VALUE,
            status: 'valid',
            reasonCode: null,
        });
        // Notional representable while the exposure underflows.
        const underflowExposure = inverseSpec(1, Number.MIN_VALUE, Number.MAX_VALUE);
        expect(absoluteNotionalQuote(underflowExposure)).toEqual({
            value: Number.MIN_VALUE,
            status: 'valid',
            reasonCode: null,
        });
        expect(absoluteExposureBaseUnits(underflowExposure)).toEqual(CALCULATION_OVERFLOW);
        // Exposure overflows while the notional is a plain number.
        const overflowExposure = inverseSpec(1, Number.MAX_VALUE, Number.MIN_VALUE);
        expect(absoluteNotionalQuote(overflowExposure)).toEqual({
            value: Number.MAX_VALUE,
            status: 'valid',
            reasonCode: null,
        });
        expect(absoluteExposureBaseUnits(overflowExposure)).toEqual(CALCULATION_OVERFLOW);
    });

    it('does not route exposure through the rounded notional', () => {
        const qty = 3.634570074369804e-86;
        const size = 1.97842180375462e-228;
        const entry = 9.79716598521918e-4;
        const spec = inverseSpec(qty, size, entry);
        const notional = absoluteNotionalQuote(spec);
        const exposure = absoluteExposureBaseUnits(spec);

        if (notional.value === null) throw new Error('the notional must be valid');
        // The published exposure is the single rounding of the exact
        // quotient; dividing the already rounded notional once more gives a
        // different, double-rounded figure.
        expect(exposure).toEqual({ value: 7.339584419878e-311, status: 'valid', reasonCode: null });
        expect(notional.value / entry).not.toBe(exposure.value);
    });

    it('keeps ordinary inverse exposures and the missing-size status', () => {
        expect(absoluteExposureBaseUnits(inverseSpec(2, 100, 8000))).toEqual({
            value: 0.025,
            status: 'valid',
            reasonCode: null,
        });
        expect(absoluteExposureBaseUnits({ ...inverseSpec(1, 1, 1), contractSizeUsd: null })).toEqual({
            value: null,
            status: 'insufficient_data',
            reasonCode: 'MISSING_INVERSE_CONTRACT_PARAMS',
        });
        for (const zero of [0, -0]) {
            expect(() => absoluteExposureBaseUnits(inverseSpec(zero, 1, 1))).toThrow(RangeError);
            expect(() => absoluteExposureBaseUnits(inverseSpec(1, 1, zero))).toThrow(RangeError);
        }
    });

    it('leaves spot and linear exposure untouched', () => {
        expect(absoluteExposureBaseUnits({
            contractKind: 'spot',
            side: 'LONG',
            qtyBase: 0.5,
            entryPrice: 40000,
            contractSizeUsd: null,
            marginCurrency: null,
        })).toEqual({ value: 0.5, status: 'valid', reasonCode: null });
        expect(absoluteExposureBaseUnits({
            contractKind: 'linear_perp',
            side: 'LONG',
            qtyBase: Number.MIN_VALUE,
            entryPrice: 1,
            contractSizeUsd: null,
            marginCurrency: null,
        })).toEqual({ value: Number.MIN_VALUE, status: 'valid', reasonCode: null });
    });

    it('matches the midpoint oracle over random significands and exponents', () => {
        fc.assert(fc.property(
            fc.bigInt({ min: 1n, max: (1n << 53n) - 1n }),
            fc.bigInt({ min: 1n, max: (1n << 53n) - 1n }),
            fc.bigInt({ min: 1n, max: (1n << 53n) - 1n }),
            fc.integer({ min: -1074, max: 970 }),
            fc.integer({ min: -1074, max: 970 }),
            fc.integer({ min: -1074, max: 970 }),
            (qtySignificand, sizeSignificand, entrySignificand, qtyExponent, sizeExponent, entryExponent) => {
                const qty = Number(qtySignificand) * 2 ** qtyExponent;
                const size = Number(sizeSignificand) * 2 ** sizeExponent;
                const entry = Number(entrySignificand) * 2 ** entryExponent;
                const math = absoluteExposureBaseUnits(inverseSpec(qty, size, entry));
                const oracle = roundedBinary64(dividedByDouble(
                    exactProduct(decodeBinary64(qty), decodeBinary64(size)),
                    decodeBinary64(entry),
                ));
                if (oracle.available) {
                    expect(math).toEqual({ value: oracle.value, status: 'valid', reasonCode: null });
                } else {
                    expect(math).toEqual({
                        value: null,
                        status: 'calculation_error',
                        reasonCode: 'CALCULATION_OVERFLOW',
                    });
                }
            },
        ), { seed: 224002, numRuns: 1500 });
    });
});

describe('inverse exposure through the public report builder', () => {
    it('publishes calculation_error for the audited input while other metrics stay valid', () => {
        const input = inversePerpInput({
            qtyBase: 1,
            contractSizeUsd: Number.MIN_VALUE,
            notionalQuote: Number.MIN_VALUE,
            entryPrice: 1e308,
            currentPrice: 1e308,
            exitPriceQuote: 1e308,
            marginCurrency: 'base',
            margin: { mode: 'isolated', rules: null },
            costs: { ...inversePerpInput().costs, fundingRatePerInterval: 0 },
        });

        // Reachability: the schema accepts this input, so the exposure error
        // is a public-contract case, not just a direct-caller one.
        expect(RiskInputSchema.safeParse(input).success).toBe(true);

        const raw = buildRiskReport(input);
        const json = JSON.stringify(raw, (_key, value: unknown) => {
            if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
            return value;
        });

        for (const report of [raw, JSON.parse(json) as typeof raw]) {
            const metrics = new Map(allMetrics(report).map((entry) => [entry.metricKey, entry]));
            expect(metrics.get('entryNotionalQuote')).toMatchObject({
                value: Number.MIN_VALUE,
                status: 'valid',
                unit: 'quote_currency',
            });
            expect(metrics.get('absoluteExposureBaseUnits')).toEqual({
                metricKey: 'absoluteExposureBaseUnits',
                value: null,
                unit: 'base_units',
                status: 'calculation_error',
                reasonCode: 'CALCULATION_OVERFLOW',
            });
            // One metric's error must not destroy the correct figures of the
            // others, and the aggregation must reflect the worst status.
            expect(metrics.get('directedExposureQuote')).toMatchObject({
                value: Number.MIN_VALUE,
                status: 'valid',
            });
            expect(metrics.get('potentialPnlQuote')).toMatchObject({ value: 0, status: 'valid' });
            expect(metrics.get('potentialPnlPercentOfEntryNotional')).toMatchObject({
                value: 0,
                status: 'valid',
            });
            expect(metrics.get('holdingCostPerIntervalQuote')).toMatchObject({
                value: 0,
                status: 'valid',
            });
            expect(metrics.get('estimatedRoundTripCostQuote')?.status).toBe('valid');
            expect(report.positionRisk).toMatchObject({
                status: 'calculation_error',
                reasonCode: 'CALCULATION_OVERFLOW',
            });
            expect(report.reportStatus).toBe('calculation_error');
            expect(report.modelVersions.positionMath).toBe('position-math@4');
            expect(report.modelVersions.assumptions).toBe('risk-assumptions@6');
        }
    });
});
