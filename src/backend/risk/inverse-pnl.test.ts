import { describe, expect, it } from 'vitest';
import { allMetrics, inversePerpInput } from './fixtures.js';
import { type PotentialPnlArgs, potentialPnl } from './position-math.js';
import { buildRiskReport } from './report.js';

const args: PotentialPnlArgs = {
    contractKind: 'inverse_perp', side: 'LONG', qtyBase: 1, contractSizeUsd: 1e-300,
    entryPrice: 1e100, exitPrice: 2e100, currentPrice: 1e100, marginCurrency: 'base',
};
const failed = { value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' };

describe('independently rounded inverse PnL', () => {
    it.each(['LONG', 'SHORT'] as const)('retains quote and percent when base underflows for %s', (side) => {
        const result = potentialPnl({ ...args, side });
        expect(result.base).toEqual(failed);
        expect(result.quote).toMatchObject({ value: side === 'LONG' ? 5e-301 : -5e-301, status: 'valid' });
        expect(result.percent).toMatchObject({ value: side === 'LONG' ? 50 : -50, status: 'valid' });
        const loss = potentialPnl({ ...args, side, entryPrice: 2e100, exitPrice: 1e100 });
        expect(loss.quote.value).toBe(side === 'LONG' ? -5e-301 : 5e-301);
        expect(loss.percent.value).toBe(side === 'LONG' ? -50 : 50);
    });

    it('keeps an unavailable base not applicable for quote settlement', () => {
        for (const input of [args, { ...args, contractSizeUsd: 1e300, entryPrice: 1e-100, exitPrice: 2e-100, currentPrice: 1e-100 }]) {
            const result = potentialPnl({ ...input, marginCurrency: 'quote' });
            expect(result.base).toMatchObject({ value: null, status: 'not_applicable', reasonCode: 'INVERSE_SETTLEMENT_NOT_BASE' });
            expect(result.quote.status).toBe('valid');
            expect(result.percent.value).toBe(50);
        }
    });

    it('retains quote after base overflow, and base/percent after quote overflow', () => {
        const baseOverflow = potentialPnl({ ...args, contractSizeUsd: 1e300, entryPrice: 1e-100, exitPrice: 2e-100, currentPrice: 1e-100 });
        expect(baseOverflow.base).toEqual(failed);
        expect(baseOverflow.quote).toMatchObject({ value: 5e299, status: 'valid' });
        expect(baseOverflow.percent.value).toBe(50);
        const quoteOverflow = potentialPnl({ ...args, contractSizeUsd: 1e300, entryPrice: 1, exitPrice: 2, currentPrice: 1e100 });
        expect(quoteOverflow.base).toMatchObject({ value: 5e299, status: 'valid' });
        expect(quoteOverflow.quote).toEqual(failed);
        expect(quoteOverflow.percent).toMatchObject({ value: 5e101, status: 'valid' });
    });

    it('retains percent when both currency metrics round to zero', () => {
        const result = potentialPnl({ ...args, contractSizeUsd: Number.MIN_VALUE, entryPrice: 1, exitPrice: 2, currentPrice: 1 });
        expect(result.base).toEqual(failed);
        expect(result.quote).toEqual(failed);
        expect(result.percent).toMatchObject({ value: 50, status: 'valid' });
    });

    it('recognizes true zero and finite results even when reciprocals overflow', () => {
        const extreme = { ...args, contractSizeUsd: Number.MIN_VALUE, entryPrice: Number.MIN_VALUE, currentPrice: 1 };
        const flat = potentialPnl({ ...extreme, exitPrice: Number.MIN_VALUE });
        for (const value of [flat.base, flat.quote, flat.percent]) expect(value).toMatchObject({ value: 0, status: 'valid' });
        const moving = potentialPnl({ ...extreme, exitPrice: 2 * Number.MIN_VALUE });
        expect(moving.base?.value).toBe(0.5);
        expect(moving.quote.value).toBe(0.5);
        expect(moving.percent).toEqual(failed);
    });

    it('retains adjacent-price movement instead of subtracting rounded reciprocals', () => {
        const result = potentialPnl({ ...args, qtyBase: 100, contractSizeUsd: 10, entryPrice: 1.5000000000000002, exitPrice: 1.5000000000000004, currentPrice: 1.5000000000000002 });
        // Independent Fraction.from_float reference for these exact inputs.
        expect(result.base?.value).toBe(9.868649107779164e-14);
        expect(result.quote.value).toBe(1.480297366166875e-13);
        expect(result.percent.value).toBe(1.480297366166875e-14);
    });

    it('uses the published rounded notional, without cancelling exact factors', () => {
        const result = potentialPnl({ ...args, qtyBase: 0.1, contractSizeUsd: 0.2, entryPrice: 1, exitPrice: 2, currentPrice: 1 });
        expect(result.percent.value).toBe(49.99999999999999);
    });

    it('reports a zero denominator as unavailable for direct callers, without throwing', () => {
        expect(potentialPnl({ ...args, qtyBase: 1e-200, contractSizeUsd: 1e-200 }).percent).toEqual(failed);
    });
});

describe('inverse report, ROM and JSON', () => {
    it('retains a finite ROM when quote overflows and errors only ROM when collateral is too small', () => {
        const base = inversePerpInput();
        const input = inversePerpInput({
            qtyBase: 1, contractSizeUsd: 1e300, notionalQuote: 1e300,
            entryPrice: 1, currentPrice: 1e100, exitPriceQuote: 1e100,
            collateralQuote: 1e300, marginCurrency: 'base',
            margin: { mode: 'isolated', rules: null }, costs: { ...base.costs, fundingRatePerInterval: 0 },
        });
        const report = buildRiskReport(input);
        const metrics = new Map(allMetrics(report).map((block) => [block.metricKey, block]));
        expect(metrics.get('unrealizedPnlQuote')).toMatchObject(failed);
        expect(metrics.get('returnOnMarginPercent')).toMatchObject({ value: 1e102, status: 'valid' });
        const smallCollateral = buildRiskReport({ ...input, contractSizeUsd: 1000, notionalQuote: 1000, collateralQuote: Number.MIN_VALUE, entryPrice: 40000, currentPrice: 45000 });
        expect(allMetrics(smallCollateral).find((block) => block.metricKey === 'unrealizedPnlQuote')?.value).toBe(125);
        expect(allMetrics(smallCollateral).find((block) => block.metricKey === 'returnOnMarginPercent')).toMatchObject(failed);
        expect(smallCollateral.reportStatus).toBe('calculation_error');
    });

    it.each(['LONG', 'SHORT'] as const)('rounds unrealized PnL and ROM independently for %s', (side) => {
        for (const underflow of [false, true]) {
            const base = inversePerpInput();
            const input = inversePerpInput({
                side, qtyBase: 1, contractSizeUsd: underflow ? Number.MIN_VALUE : 1e-300,
                notionalQuote: underflow ? Number.MIN_VALUE : 1e-300,
                collateralQuote: underflow ? Number.MIN_VALUE : 1e-300,
                entryPrice: underflow ? 1 : 1e100, currentPrice: underflow ? 1.5 : 2e100,
                exitPriceQuote: underflow ? 1.5 : 2e100, marginCurrency: 'base',
                margin: { mode: 'isolated', rules: null }, costs: { ...base.costs, fundingRatePerInterval: 0 },
            });
            const raw = buildRiskReport(input);
            const json = JSON.stringify(raw, (_key, value: unknown) => {
                expect(typeof value).not.toBe('bigint');
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            });
            for (const report of [raw, JSON.parse(json) as typeof raw]) {
                const metrics = new Map(allMetrics(report).map((block) => [block.metricKey, block]));
                const sign = side === 'LONG' ? 1 : -1;
                expect(metrics.get('unrealizedPnlQuote')).toMatchObject(underflow ? failed : { value: sign * 1e-300, status: 'valid' });
                expect(metrics.get('unrealizedPnlPercentOfEntryNotional')).toMatchObject({ value: sign * (underflow ? 50 : 100), status: 'valid' });
                expect(metrics.get('returnOnMarginPercent')).toMatchObject({ value: sign * (underflow ? 50 : 100), status: 'valid' });
                expect(metrics.get('potentialPnlBaseUnits')).toMatchObject(failed);
                expect(report.positionRisk.status).toBe('calculation_error');
                expect(report.positionRisk.reasonCode).toBe('CALCULATION_OVERFLOW');
                expect(report.reportStatus).toBe('calculation_error');
                expect(report.marginViolation.detected).toBeNull();
                expect(report.liquidationConsequences.status).toBe('insufficient_data');
            }
        }
    });
});
