import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runRiskReportCli } from '../research/risk-report.cli.js';
import type { RiskReport } from '../types/risk.js';
import { finiteProduct } from './finite-product.js';
import { allMetrics, inversePerpInput, linearPerpInput, reviewedLinearRules, spotInput } from './fixtures.js';
import { linearIsolatedLiquidationPrice } from './liquidation-contract.js';
import { absoluteNotionalQuote, estimatedRoundTripCost, type PositionSpec } from './position-math.js';
import { buildRiskReport } from './report.js';
import { RiskInputSchema } from './schema.js';
import { add, div, failure, fromNumber, mul, rounded, sub } from './test-support/fraction-oracle.js';

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true });
const spec = (qtyBase: number, entryPrice: number): PositionSpec => ({
    contractKind: 'linear_perp', side: 'LONG', qtyBase, entryPrice,
    contractSizeUsd: null, marginCurrency: null,
});
function serialize(report: RiskReport): RiskReport {
    return JSON.parse(JSON.stringify(report, (_key, value: unknown) => {
        expect(typeof value).not.toBe('bigint');
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        return value;
    })) as RiskReport;
}
const metrics = (report: RiskReport) => new Map(allMetrics(report).map((block) => [block.metricKey, block]));
const zeroCosts = { takerFeeRate: 0, spreadRate: 0, slippageRate: 0, executionReserveRate: 0 };

describe('YAR-11 linear notional and schema', () => {
    it('rejects the audited underflow at the schema/CLI boundary, naming notionalQuote', () => {
        // No positive binary64 notional can encode the rounded exact product.
        // These values were accepted by the old absolute tolerance floor.
        for (const notionalQuote of [Number.MIN_VALUE, 1e-300, 1e-10]) {
            const input = linearPerpInput({ qtyBase: 1e-200, entryPrice: 1e-200, notionalQuote });
            const parsed = RiskInputSchema.safeParse(input);
            expect(parsed.success).toBe(false);
            if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path[0] === 'notionalQuote')).toBe(true);
            const output: string[] = [];
            const errors: string[] = [];
            expect(runRiskReportCli(['node', 'risk-report', 'input.json'], {
                read: () => JSON.stringify(input), write: (text) => { output.push(text); },
                error: (text) => { errors.push(text); },
            })).toBe(1);
            expect(output).toEqual([]);
            expect(errors.join('')).toContain('notionalQuote');
        }
        expect(absoluteNotionalQuote(spec(1e-200, 1e-200))).toEqual(failure);
    });

    it.each([
        [Number.MIN_VALUE, 0.5, null],
        [Number.MIN_VALUE, 0.75, Number.MIN_VALUE],
        [Number.MIN_VALUE, 1.5, 2 * Number.MIN_VALUE],
        [Number.MIN_VALUE, 2.5, 2 * Number.MIN_VALUE],
        [2 ** -1022, 1 - Number.EPSILON / 2, 2 ** -1022],
        [2 ** -1022, 1 - Number.EPSILON, 2 ** -1022 - Number.MIN_VALUE],
        [1 + Number.EPSILON, 1.5, 1.5 + 2 * Number.EPSILON],
        [1 + 2 * Number.EPSILON, 1.25, 1.25 + 2 * Number.EPSILON],
        [Number.MAX_VALUE, 1, Number.MAX_VALUE],
        [Number.MAX_VALUE, 2, null],
        [Number.MAX_VALUE, 1 + Number.EPSILON, null],
    ])('rounds %s x %s once, including ties and the normal boundary', (qty, entry, value) => {
        const result = absoluteNotionalQuote(spec(qty, entry));
        expect(result).toEqual(rounded(mul(fromNumber(qty), fromNumber(entry))));
        expect(result.value).toBe(value);
        expect(RiskInputSchema.safeParse(linearPerpInput({
            qtyBase: qty, entryPrice: entry, notionalQuote: value ?? Number.MIN_VALUE,
        })).success).toBe(value !== null);
    });

    it.each([
        [1, 1e-20, 1e-10, false],
        [1, 1e-300, 1.01e-300, false],
        [1, 1e-300, 1.0000005e-300, true],
        [1, 1e300, 1.0000005e300, true],
        [1, Number.MIN_VALUE, 2 * Number.MIN_VALUE, false],
        [1, 1e-318, 1e-318 + Number.MIN_VALUE, false],
        [0.1, 0.2, 0.02, true],
    ])('uses relative consistency for %s x %s versus %s', (qtyBase, entryPrice, notionalQuote, accepted) => {
        expect(RiskInputSchema.safeParse(linearPerpInput({ qtyBase, entryPrice, notionalQuote })).success).toBe(accepted);
    });

    it('preserves required-positive and missing-input semantics', () => {
        for (const field of ['qtyBase', 'entryPrice', 'notionalQuote'] as const) {
            for (const value of [0, -0, -1, -Number.MIN_VALUE, Number.NaN, Infinity, -Infinity]) {
                expect(RiskInputSchema.safeParse({ ...linearPerpInput(), [field]: value }).success).toBe(false);
            }
            const input: Record<string, unknown> = { ...linearPerpInput() };
            delete input[field];
            expect(RiskInputSchema.safeParse(input).success).toBe(false);
        }
        for (const value of [0, -0, -1, -Number.MIN_VALUE]) {
            expect(() => absoluteNotionalQuote(spec(value, 1))).toThrow(RangeError);
            expect(() => absoluteNotionalQuote(spec(1, value))).toThrow(RangeError);
        }
        expect(finiteProduct(0, 1e-200, 1e-200)).toMatchObject({ value: 0, status: 'valid' });
        const input = RiskInputSchema.parse(linearPerpInput({
            exitPriceQuote: null, invalidationLevelQuote: null,
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: null },
        }));
        const report = serialize(buildRiskReport(input));
        expect(metrics(report).get('potentialPnlQuote')?.reasonCode).toBe('EXIT_PRICE_NOT_PROVIDED');
        expect(metrics(report).get('invalidationDistanceQuote')?.reasonCode).toBe('INVALIDATION_LEVEL_NOT_PROVIDED');
        expect(metrics(report).get('holdingCostPerIntervalQuote')).toMatchObject({ value: null, status: 'degraded', reasonCode: 'UNKNOWN_FUNDING' });
    });

    it('matches an independent adjacent-value oracle across binary64', () => {
        fc.assert(fc.property(positive, positive, (qty, entry) => {
            expect(absoluteNotionalQuote(spec(qty, entry))).toEqual(rounded(mul(fromNumber(qty), fromNumber(entry))));
        }), { seed: 231001, numRuns: 1000 });
    });
});

describe('YAR-11 cost and public reporting', () => {
    it.each(['LONG', 'SHORT'] as const)('safeParse → builder → metrics → statuses → JSON for subnormal %s', (side) => {
        const parsed = RiskInputSchema.safeParse(linearPerpInput({
            side, qtyBase: Number.MIN_VALUE, entryPrice: 1.49, currentPrice: 1.49,
            exitPriceQuote: 1.49, notionalQuote: Number.MIN_VALUE, collateralQuote: Number.MIN_VALUE,
        }));
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw parsed.error;
        const report = buildRiskReport(parsed.data);
        for (const actual of [report, serialize(report)]) {
            expect(metrics(actual).get('entryNotionalQuote')).toMatchObject({ value: Number.MIN_VALUE, status: 'valid' });
            expect(metrics(actual).get('estimatedRoundTripCostQuote')).toMatchObject(failure);
            expect(metrics(actual).get('estimatedRoundTripCostPercentOfEntryNotional')?.status).toBe('valid');
            expect(actual.positionRisk).toMatchObject({ status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' });
            expect(actual.reportStatus).toBe('calculation_error');
            expect(actual.schemaVersion).toBe('risk-report/1');
        }
        const output: string[] = [];
        expect(runRiskReportCli(['node', 'risk-report', 'input.json'], {
            read: () => JSON.stringify(parsed.data), write: (text) => { output.push(text); },
            error: (text) => { throw new Error(text); },
        })).toBe(0);
        expect(JSON.parse(output.join('')).reportStatus).toBe('calculation_error');
    });

    it('distinguishes true zero costs, tiny nonzero costs and independently representable percent', () => {
        expect(estimatedRoundTripCost(Number.MIN_VALUE, zeroCosts)).toEqual({
            quote: { value: 0, status: 'valid', reasonCode: null },
            percent: { value: 0, status: 'valid', reasonCode: null },
        });
        const result = estimatedRoundTripCost(1, { ...zeroCosts, spreadRate: Number.MIN_VALUE });
        expect(result.quote).toMatchObject({ value: Number.MIN_VALUE, status: 'valid' });
        expect(result.percent).toMatchObject({ value: 100 * Number.MIN_VALUE, status: 'valid' });
        expect(estimatedRoundTripCost(Number.MIN_VALUE, { ...zeroCosts, spreadRate: 0.5 })).toEqual({
            quote: failure, percent: { value: 50, status: 'valid', reasonCode: null },
        });
        expect(estimatedRoundTripCost(Number.MAX_VALUE, {
            takerFeeRate: 0.1, spreadRate: 0.5, slippageRate: 0.5, executionReserveRate: 0.5,
        }).quote).toEqual(failure);
    });

    it('matches independent fractions for cost quote and percent, including tiny rates', () => {
        const rate = fc.double({ min: 0, max: 0.5, noNaN: true });
        fc.assert(fc.property(positive, rate, rate, rate, rate, (notional, taker, spread, slippage, reserve) => {
            const total = add(mul(fromNumber(2), add(add(fromNumber(taker), fromNumber(slippage)), fromNumber(reserve))), fromNumber(spread));
            const result = estimatedRoundTripCost(notional, {
                takerFeeRate: taker, spreadRate: spread, slippageRate: slippage, executionReserveRate: reserve,
            });
            expect(result.quote).toEqual(rounded(mul(fromNumber(notional), total)));
            expect(result.percent).toEqual(rounded(mul(fromNumber(100), total)));
        }), { seed: 231002, numRuns: 500 });
    });

    it('keeps spot underflow schema-valid without letting it reach the positive-cost guard', () => {
        const parsed = RiskInputSchema.parse(spotInput({ qtyBase: 1e-200, entryPrice: 1e-200, notionalQuote: Number.MIN_VALUE }));
        const report = serialize(buildRiskReport(parsed));
        for (const key of ['entryNotionalQuote', 'directedExposureQuote', 'estimatedRoundTripCostQuote']) {
            expect(metrics(report).get(key)).toMatchObject(failure);
        }
        expect(report.reportStatus).toBe('calculation_error');
    });
});

describe('YAR-11 existing liquidation geometry', () => {
    it('uses exact collateral comparison for a rounded-down subnormal entry notional', () => {
        const result = linearIsolatedLiquidationPrice({
            side: 'LONG', qtyBase: Number.MIN_VALUE, entryPrice: 1.49,
            collateralQuote: Number.MIN_VALUE, maintenanceMarginRate: 0.01,
        });
        expect(result.status).toBe('valid');
        expect(result.reasonCode).toBeNull();
        expect(result.liquidationPriceQuote).toBeCloseTo(0.49 / 0.99, 14);
        expect(result.projectedLossQuote).toBe(Number.MIN_VALUE);
    });

    it.each(['LONG', 'SHORT'] as const)('refuses a %s price or positive loss that rounds to zero', (side) => {
        const result = linearIsolatedLiquidationPrice({
            side, qtyBase: Number.MIN_VALUE, entryPrice: 1.25,
            collateralQuote: Number.MIN_VALUE, maintenanceMarginRate: 0.7,
        });
        // Both exact positive gross losses are below half a quantum.
        expect(result).toMatchObject({ status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW', liquidationPriceQuote: null, projectedLossQuote: null });
        const tinyPrice = linearIsolatedLiquidationPrice({
            side: 'LONG', qtyBase: 1, entryPrice: 2 * Number.MIN_VALUE,
            collateralQuote: Number.MIN_VALUE, maintenanceMarginRate: 0,
        });
        expect(tinyPrice.status).toBe('valid');
        const roundedZero = linearIsolatedLiquidationPrice({
            side: 'LONG', qtyBase: 2.5, entryPrice: Number.MIN_VALUE,
            collateralQuote: 2 * Number.MIN_VALUE, maintenanceMarginRate: 0,
        });
        expect(roundedZero).toMatchObject({ status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW', liquidationPriceQuote: null });
    });

    it('matches independently rounded fractions for the unchanged price/loss formula', () => {
        fc.assert(fc.property(positive, positive, positive,
            fc.double({ min: 0, max: 0.99, noNaN: true }), fc.constantFrom('LONG', 'SHORT'),
            (qty, entry, collateral, mmr, side) => {
                const notional = mul(fromNumber(qty), fromNumber(entry));
                const numerator = side === 'LONG' ? sub(notional, fromNumber(collateral)) : add(notional, fromNumber(collateral));
                const result = linearIsolatedLiquidationPrice({
                    side, qtyBase: qty, entryPrice: entry, collateralQuote: collateral, maintenanceMarginRate: mmr,
                });
                if (side === 'LONG' && numerator.n <= 0n) {
                    expect(result).toMatchObject({ status: 'not_applicable', reasonCode: 'LIQUIDATION_NOT_REACHABLE', liquidationPriceQuote: null });
                    return;
                }
                const factor = side === 'LONG' ? sub(fromNumber(1), fromNumber(mmr)) : add(fromNumber(1), fromNumber(mmr));
                const price = div(numerator, mul(fromNumber(qty), factor));
                const gap = side === 'LONG' ? sub(fromNumber(entry), price) : sub(price, fromNumber(entry));
                const priceResult = rounded(price);
                const lossResult = rounded(gap.n > 0n ? mul(gap, fromNumber(qty)) : fromNumber(0));
                if (priceResult.status === 'calculation_error' || lossResult.status === 'calculation_error') {
                    expect(result).toMatchObject({ status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW', liquidationPriceQuote: null, projectedLossQuote: null });
                } else {
                    expect(result).toEqual({ status: 'valid', reasonCode: null, liquidationPriceQuote: priceResult.value, projectedLossQuote: lossResult.value });
                }
            }), { seed: 231003, numRuns: 1000 });
    });
});

it('schema-valid inputs build and serialize without exceptions across instruments and binary64', () => {
    let accepted = 0;
    fc.assert(fc.property(
        positive, positive, positive, positive,
        fc.constantFrom('spot', 'linear_perp', 'inverse_perp'), fc.constantFrom('LONG', 'SHORT'),
        fc.constantFrom('isolated', 'cross', 'missing', 'draft'),
        fc.constantFrom(0, Number.MIN_VALUE, 0.001, 1, null),
        (qty, entry, current, collateral, kind, side, margin, funding) => {
            const inverse = kind === 'inverse_perp';
            const fixture = inverse ? inversePerpInput() : linearPerpInput();
            const input = {
                ...fixture, contractKind: kind, side, qtyBase: qty, entryPrice: entry,
                currentPrice: current, exitPriceQuote: current,
                notionalQuote: Number.isFinite(qty * entry) && qty * entry > 0 ? qty * entry : Number.MIN_VALUE,
                contractSizeUsd: inverse ? entry : null, marginCurrency: inverse ? 'base' as const : null,
                collateralQuote: kind === 'spot' ? null : collateral,
                margin: kind === 'spot' ? { mode: null, rules: null } : {
                    mode: margin === 'cross' ? 'cross' as const : 'isolated' as const,
                    rules: margin === 'missing' ? null : inverse ? null : reviewedLinearRules({
                        mode: margin === 'cross' ? 'cross' : 'isolated',
                        reviewStatus: margin === 'draft' ? 'draft' : 'reviewed',
                    }),
                },
                costs: { ...fixture.costs, fundingRatePerInterval: funding },
            };
            const parsed = RiskInputSchema.safeParse(input);
            if (!parsed.success) return;
            accepted += 1;
            const report = buildRiskReport(parsed.data);
            const json = serialize(report);
            expect(json.reportStatus).toBe(report.reportStatus);
            if (allMetrics(report).some((block) => block.status === 'calculation_error')) {
                expect(report.reportStatus).toBe('calculation_error');
            }
            if (report.positionRisk.metrics.some((block) => block.status === 'calculation_error')) {
                expect(report.positionRisk.status).toBe('calculation_error');
            }
        },
    ), { seed: 231004, numRuns: 1000 });
    expect(accepted).toBeGreaterThan(400);
}, 60_000);
