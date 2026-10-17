import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { RiskReport } from '../types/risk.js';
import { allMetrics, inversePerpInput, linearPerpInput, reviewedInverseRules, reviewedLinearRules } from './fixtures.js';
import { buildRiskReport } from './report.js';

it('keeps wide-exponent reports and their serialized values finite with honest aggregate statuses', () => {
    fc.assert(fc.property(
        fc.integer({ min: 0, max: 308 }),
        fc.integer({ min: 0, max: 300 }),
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        fc.constantFrom('LONG', 'SHORT'),
        fc.constantFrom('spot', 'linear_perp', 'inverse_perp'),
        fc.constantFrom(-1, 0, 0.0001, 1, null),
        (notionalExponent, qtyExponent, ratio, collateralPart, side, contractKind, fundingRatePerInterval) => {
            const notionalQuote = 10 ** notionalExponent;
            const qtyBase = 10 ** qtyExponent;
            const entryPrice = notionalQuote / qtyBase;
            const currentPrice = entryPrice * ratio;
            fc.pre(Number.isFinite(currentPrice));
            const isSpot = contractKind === 'spot';
            const isInverse = contractKind === 'inverse_perp';
            const makeInput = isInverse ? inversePerpInput : linearPerpInput;
            const makeRules = isInverse ? reviewedInverseRules : reviewedLinearRules;
            const report = buildRiskReport(makeInput({
                contractKind, side, qtyBase, entryPrice, currentPrice, notionalQuote,
                collateralQuote: isSpot ? null : notionalQuote * collateralPart,
                contractSizeUsd: isInverse ? entryPrice : null,
                marginCurrency: isInverse ? 'base' : null,
                exitPriceQuote: currentPrice,
                margin: isSpot ? { mode: null, rules: null } : {
                    mode: 'isolated',
                    rules: makeRules({
                        contractKind,
                        ...(isInverse ? {
                            liquidationFormulaId: 'inverse_manual_v1',
                            contractSizeUsd: entryPrice,
                            marginCurrency: 'base',
                        } : {}),
                    }),
                },
                costs: { ...linearPerpInput().costs, fundingRatePerInterval },
            }));
            const serialized = JSON.parse(JSON.stringify(report, (_key, value: unknown) => {
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            })) as RiskReport;
            // JSON normalizes signed zero; finite values and validity must survive.
            expect(serialized.reportStatus).toBe(report.reportStatus);
            const metrics = allMetrics(serialized);
            if (serialized.positionRisk.status === 'calculation_error') {
                expect(serialized.positionRisk.reasonCode).toBe('CALCULATION_OVERFLOW');
            }
            for (const block of metrics) {
                if (block.status === 'valid') expect(block.value).not.toBeNull();
                if (block.status === 'calculation_error') {
                    expect(block.reasonCode).toBe('CALCULATION_OVERFLOW');
                }
            }
            if (serialized.marginViolation.status === 'calculation_error') {
                expect(serialized.marginViolation.detected).toBeNull();
                expect(serialized.marginViolation.atBar).toBeNull();
            }
            if (metrics.some((block) => block.status === 'calculation_error') ||
                serialized.marginViolation.status === 'calculation_error' ||
                serialized.liquidationConsequences.status === 'calculation_error') {
                expect(serialized.reportStatus).toBe('calculation_error');
            }
            if (contractKind === 'linear_perp') {
                // Independent basis: entry notional times the market move,
                // applying the maintenance rate before that move can overflow.
                const expected = (notionalQuote * 0.01) * ratio;
                expect(serialized.marginViolation.maintenanceRequirementQuote! / expected).toBeCloseTo(1, 10);
            }
        },
    ), { numRuns: 500 });
});

it('R1: matches exact exponent references for small prices, large quantities, signed rates and zero', () => {
    fc.assert(fc.property(
        fc.integer({ min: -500, max: 1000 }),
        fc.integer({ min: 0, max: 1023 }),
        fc.integer({ min: -1074, max: -4 }),
        fc.constantFrom(-1, 0, 1),
        fc.constantFrom('LONG', 'SHORT'),
        (notionalExponent, qtyExponent, rateExponent, fundingSign, side) => {
            const priceExponent = notionalExponent - qtyExponent;
            fc.pre(priceExponent >= -1074);
            const price = 2 ** priceExponent;
            const rate = 2 ** rateExponent;
            // Independent oracle: all inputs are exact powers of two, so
            // their product is 2^(sum of exponents), including subnormals.
            const expectedMaintenance = 2 ** (notionalExponent + rateExponent);
            const collateral = Math.max(Number.MIN_VALUE, 2 ** (notionalExponent + rateExponent - 1));
            const report = buildRiskReport(linearPerpInput({
                side, qtyBase: 2 ** qtyExponent,
                entryPrice: price, currentPrice: price, exitPriceQuote: price,
                notionalQuote: 2 ** notionalExponent, collateralQuote: collateral,
                atr: { ...linearPerpInput().atr, value: 1 },
                margin: { mode: 'isolated', rules: reviewedLinearRules({ maintenanceMarginRate: rate }) },
                costs: { ...linearPerpInput().costs, fundingRatePerInterval: fundingSign * rate },
            }));
            const serialized = JSON.parse(JSON.stringify(report, (_key, value: unknown) => {
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            })) as RiskReport;
            const funding = serialized.positionRisk.metrics.find(
                (block) => block.metricKey === 'holdingCostPerIntervalQuote',
            )!;

            expect(serialized.marginViolation.equityQuote).toBe(collateral);
            if (expectedMaintenance === 0) {
                expect(serialized.marginViolation).toMatchObject({
                    maintenanceRequirementQuote: null, detected: null, atBar: null,
                    status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
                });
                expect(serialized.reportStatus).toBe('calculation_error');
            } else {
                expect(serialized.marginViolation.maintenanceRequirementQuote).toBe(expectedMaintenance);
                expect(serialized.marginViolation.detected).toBe(collateral < expectedMaintenance);
                expect(serialized.marginViolation.status).toBe('valid');
                expect(serialized.reportStatus).toBe('valid');
            }
            if (fundingSign === 0) {
                expect(funding).toMatchObject({ value: 0, status: 'valid' });
            } else if (expectedMaintenance === 0) {
                expect(funding).toMatchObject({
                    value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
                });
            } else {
                const sideSign = side === 'LONG' ? 1 : -1;
                expect(funding.value).toBe(sideSign * fundingSign * expectedMaintenance);
                expect(funding.status).toBe('valid');
            }
        },
    ), { numRuns: 1000, examples: [
        [0, 700, -700, 1, 'LONG'],
        [0, 700, -700, -1, 'SHORT'],
        [1000, 1023, -1074, 0, 'LONG'],
        [-500, 500, -1000, -1, 'LONG'],
    ] });
});
