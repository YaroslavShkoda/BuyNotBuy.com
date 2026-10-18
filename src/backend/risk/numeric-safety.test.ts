import { describe, expect, it } from 'vitest';
import type { RiskReport } from '../types/risk.js';
import { allMetrics, inversePerpInput, linearPerpInput, reviewedLinearRules } from './fixtures.js';
import { buildRiskReport } from './report.js';
import type { RiskInput } from './schema.js';
import { div, fromNumber, mul, rounded, sub } from './test-support/fraction-oracle.js';

/** Checks BEFORE JSON can silently turn a non-finite number into null. */
function serializedSafeReport(report: RiskReport): RiskReport {
    const json = JSON.stringify(report, (_key, value: unknown) => {
        if (typeof value === 'number') {
            expect(Number.isFinite(value)).toBe(true);
        }
        return value;
    });
    const serialized = JSON.parse(json) as RiskReport;

    expect(serialized.reportStatus).toBe(report.reportStatus);
    for (const block of allMetrics(serialized)) {
        if (block.status === 'valid') {
            expect(block.value).not.toBeNull();
            expect(Number.isFinite(block.value)).toBe(true);
        }
    }
    return serialized;
}

function largeInput(overrides: Partial<RiskInput> = {}): RiskInput {
    return linearPerpInput({
        qtyBase: 1e200,
        entryPrice: 1e108,
        currentPrice: 2e108,
        notionalQuote: 1e308,
        collateralQuote: 1e307,
        margin: { mode: 'isolated', rules: reviewedLinearRules() },
        ...overrides,
    });
}

function byKey(report: RiskReport, key: string) {
    const block = report.positionRisk.metrics.find((candidate) => candidate.metricKey === key);
    expect(block).toBeDefined();
    return block!;
}

function expectOverflow(block: { value: number | null; status: string; reasonCode: string | null }) {
    expect(block).toMatchObject({
        value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
    });
}

describe('RiskReport numeric safety', () => {
    it('detects a margin violation with a tiny price and tiny maintenance rate (R1 A)', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({
            qtyBase: 1e200, entryPrice: 1e-200, currentPrice: 1e-200,
            exitPriceQuote: 1e-200, notionalQuote: 1, collateralQuote: 1e-201,
            margin: { mode: 'isolated', rules: reviewedLinearRules({ maintenanceMarginRate: 1e-200 }) },
        })));

        expect(report.marginViolation.equityQuote).toBe(1e-201);
        expect(report.marginViolation.maintenanceRequirementQuote! / 1e-200).toBeCloseTo(1, 14);
        expect(report.marginViolation.detected).toBe(true);
        expect(report.marginViolation.status).toBe('valid');
        expect(report.reportStatus).toBe('valid');
    });

    it('preserves maintenance at a subnormal price with an ordinary rate (R1 B)', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({
            qtyBase: 1e308, entryPrice: 1e-323, currentPrice: 1e-323,
            exitPriceQuote: 1e-323, notionalQuote: 9.881312916824931e-16,
            collateralQuote: 1e-18,
            atr: { ...linearPerpInput().atr, value: 1 },
            margin: { mode: 'isolated', rules: reviewedLinearRules() },
        })));

        expect(report.marginViolation.maintenanceRequirementQuote! / 9.881312916824931e-18).toBeCloseTo(1, 14);
        expect(report.marginViolation.detected).toBe(true);
        expect(report.marginViolation.status).toBe('valid');
        expect(report.reportStatus).toBe('valid');
    });

    it.each([1, -1])('preserves tiny linear funding with sign %s (R1 C)', (sign) => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({
            qtyBase: 1e200, entryPrice: 1e-200, currentPrice: 1e-200,
            exitPriceQuote: 1e-200, notionalQuote: 1, collateralQuote: 0.1,
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: sign * 1e-200 },
            margin: { mode: 'isolated', rules: reviewedLinearRules() },
        })));

        const funding = byKey(report, 'holdingCostPerIntervalQuote');
        expect(funding.value! / (sign * 1e-200)).toBeCloseTo(1, 14);
        expect(funding.status).toBe('valid');
        expect(report.marginViolation.detected).toBe(false);
        expect(report.reportStatus).toBe('valid');
    });

    it('computes finite maintenance and funding without forming an overflowing current notional', () => {
        const report = serializedSafeReport(buildRiskReport(largeInput()));

        // 1% of a mathematical current notional of 2e308 is 2e306.
        expect(report.marginViolation.maintenanceRequirementQuote! / 2e306).toBeCloseTo(1, 12);
        expect(report.marginViolation.equityQuote).toBe(1.1e308);
        expect(report.marginViolation.detected).toBe(false);
        expect(report.marginViolation.status).toBe('valid');
        expect(byKey(report, 'holdingCostPerIntervalQuote').value! / 2e304).toBeCloseTo(1, 12);
        expect(report.reportStatus).toBe('valid');
    });

    it('refuses a margin decision when a nonzero final requirement rounds to zero', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({
            qtyBase: 1, entryPrice: 1e-200, currentPrice: 1e-200,
            exitPriceQuote: 1e-200, notionalQuote: 1e-200, collateralQuote: 1e-201,
            margin: { mode: 'isolated', rules: reviewedLinearRules({ maintenanceMarginRate: 1e-200 }) },
        })));

        expect(report.marginViolation).toMatchObject({
            maintenanceRequirementQuote: null, detected: null,
            status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
        });
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('reports a nonzero final funding payment below the Number range as an error', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({
            qtyBase: 1, entryPrice: 1e-200, currentPrice: 1e-200,
            exitPriceQuote: 1e-200, notionalQuote: 1e-200, collateralQuote: 1e-201,
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: -1e-200 },
            margin: { mode: 'isolated', rules: reviewedLinearRules() },
        })));

        expectOverflow(byKey(report, 'holdingCostPerIntervalQuote'));
        expect(report.marginViolation.status).toBe('valid');
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('refuses a margin decision when equity overflows, even with draft rules', () => {
        for (const reviewStatus of ['reviewed', 'draft'] as const) {
            const report = serializedSafeReport(buildRiskReport(largeInput({
                currentPrice: 1.5e108,
                collateralQuote: 1.5e308,
                margin: { mode: 'isolated', rules: reviewedLinearRules({ reviewStatus }) },
            })));

            expect(report.marginViolation).toMatchObject({
                detected: null, atBar: null, equityQuote: null,
                status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
            });
            expect(report.reportStatus).toBe('calculation_error');
        }
    });

    it('computes zero funding without multiplying zero by an infinite intermediate', () => {
        const report = serializedSafeReport(buildRiskReport(largeInput({
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: 0 },
        })));

        expect(byKey(report, 'holdingCostPerIntervalQuote')).toMatchObject({ value: 0, status: 'valid' });
        expect(report.reportStatus).toBe('valid');
    });

    it.each(['LONG', 'SHORT'] as const)('rounds %s percent and ROM independently of overflowing quote PnL', (side) => {
        const input = largeInput({ side, currentPrice: 1e110 });
        const report = serializedSafeReport(buildRiskReport(input));
        const pnl = mul(sub(fromNumber(input.currentPrice), fromNumber(input.entryPrice)),
            fromNumber(side === 'LONG' ? input.qtyBase : -input.qtyBase));
        const publishedNotional = rounded(mul(fromNumber(input.qtyBase), fromNumber(input.entryPrice)));
        expectOverflow(byKey(report, 'unrealizedPnlQuote'));
        expect(byKey(report, 'unrealizedPnlPercentOfEntryNotional')).toMatchObject(
            rounded(div(mul(pnl, fromNumber(100)), fromNumber(publishedNotional.value!))),
        );
        expect(byKey(report, 'returnOnMarginPercent')).toMatchObject(
            rounded(div(mul(pnl, fromNumber(100)), fromNumber(input.collateralQuote!))),
        );
        expect(report.marginViolation).toMatchObject({
            detected: null, atBar: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
        });
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('reports overflowing return on margin separately from a finite PnL', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({ collateralQuote: 1e-308 })));

        expect(byKey(report, 'unrealizedPnlQuote').value).toBe(500);
        expectOverflow(byKey(report, 'returnOnMarginPercent'));
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('marks an unrepresentable holding cost as a calculation error', () => {
        const report = serializedSafeReport(buildRiskReport(largeInput({
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: 1 },
        })));

        expectOverflow(byKey(report, 'holdingCostPerIntervalQuote'));
        expect(report.marginViolation.status).toBe('valid');
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('recovers a finite SHORT liquidation price from an overflowing notional-plus-collateral sum', () => {
        const report = serializedSafeReport(buildRiskReport(largeInput({
            side: 'SHORT', currentPrice: 1e108, collateralQuote: 1e308,
        })));

        // Per unit: (1e108 + 1e108) / 1.01, with finite loss about 9.802e307.
        expect(report.liquidationConsequences.point.liquidationPriceQuote! / (2e108 / 1.01)).toBeCloseTo(1, 12);
        expect(report.liquidationConsequences.status).toBe('valid');
        expect(report.distances.percentDistance.status).toBe('valid');
        expect(report.distances.atrDistance.status).toBe('valid');
        expect(report.reportStatus).toBe('valid');
    });

    it('propagates an unrepresentable liquidation price to the section and distances', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({
            side: 'SHORT', qtyBase: 1, entryPrice: 1e308, currentPrice: 1e308,
            notionalQuote: 1e308, collateralQuote: 1e308,
            margin: { mode: 'isolated', rules: reviewedLinearRules() },
        })));

        expect(report.liquidationConsequences).toMatchObject({
            point: { liquidationPriceQuote: null, projectedLossQuote: null },
            status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
        });
        expectOverflow(report.distances.percentDistance);
        expectOverflow(report.distances.atrDistance);
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('recovers a finite liquidation price when quantity times the margin factor overflows', () => {
        const report = serializedSafeReport(buildRiskReport(largeInput({
            side: 'SHORT', qtyBase: 1.79e308, entryPrice: 0.5,
            currentPrice: 0.5, notionalQuote: 8.95e307,
            collateralQuote: 8.95e307, exitPriceQuote: 0.5,
        })));

        expect(report.liquidationConsequences.point.liquidationPriceQuote).toBeCloseTo(1 / 1.01, 12);
        expect(report.liquidationConsequences.status).toBe('valid');
        expect(report.reportStatus).toBe('valid');
    });

    it('keeps a projected loss near the numeric limit finite', () => {
        const report = serializedSafeReport(buildRiskReport(largeInput({
            side: 'SHORT', currentPrice: 1e108, collateralQuote: 1.79e308,
        })));

        // Loss = (collateral - entryNotional * MMR) / (1 + MMR).
        expect(report.liquidationConsequences.status).toBe('valid');
        expect(report.liquidationConsequences.point.projectedLossQuote! / ((1.79e308 - 1e306) / 1.01)).toBeCloseTo(1, 12);
    });

    it('does not publish overflowing liquidation distances as valid', () => {
        const report = serializedSafeReport(buildRiskReport(linearPerpInput({ currentPrice: 1e-308 })));

        expect(report.liquidationConsequences.status).toBe('valid');
        expectOverflow(report.distances.percentDistance);
        expectOverflow(report.distances.atrDistance);
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('does not turn an overflowing ATR normalization into a false zero distance', () => {
        const input = largeInput();
        const report = serializedSafeReport(buildRiskReport({
            ...input, atr: { ...input.atr, value: 1e308 },
            invalidationLevelQuote: 5e107,
        }));

        const distance = report.distances.atrDistance;
        expect(distance.status).toBe('valid');
        // Liquidation/current = (0.9 / 0.99) / 2.
        expect(distance.value! / ((1 - 0.9 / 0.99 / 2) / 1e308)).toBeCloseTo(1, 12);
        const invalidationAtr = byKey(report, 'invalidationDistanceAtr');
        expect(invalidationAtr.status).toBe('valid');
        expect(invalidationAtr.value! / 5e-309).toBeCloseTo(1, 12);
    });

    it('preserves ordinary linear and inverse results through serialization', () => {
        const linear = serializedSafeReport(buildRiskReport(linearPerpInput()));
        expect(byKey(linear, 'unrealizedPnlQuote').value).toBe(500);
        expect(byKey(linear, 'returnOnMarginPercent').value).toBe(12.5);
        expect(linear.marginViolation.equityQuote).toBe(4500);

        const inverse = serializedSafeReport(buildRiskReport(inversePerpInput({
            contractKind: 'inverse_perp', qtyBase: 100, contractSizeUsd: 10,
            marginCurrency: 'base', notionalQuote: 1000,
            currentPrice: 45000, exitPriceQuote: 50000,
            margin: { mode: 'isolated', rules: null },
        })));
        expect(byKey(inverse, 'unrealizedPnlQuote').value).toBeCloseTo(125, 9);
        expect(byKey(inverse, 'unrealizedPnlPercentOfEntryNotional').value).toBeCloseTo(12.5, 9);
        expect(byKey(inverse, 'potentialPnlQuote').value).toBeCloseTo(225, 9);
        expect(byKey(inverse, 'potentialPnlPercentOfEntryNotional').value).toBeCloseTo(22.5, 9);
    });
});
