import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { RiskReport } from '../types/risk.js';
import { allMetrics, inversePerpInput } from './fixtures.js';
import { buildRiskReport } from './report.js';

it('uses USD contract nominal for inverse funding across price, quantity, settlement and rate ranges', () => {
    fc.assert(fc.property(
        fc.integer({ min: -300, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -1074, max: -1 }),
        fc.constantFrom(-1, 0, 1),
        fc.constantFrom('LONG', 'SHORT'),
        fc.constantFrom('base', 'quote'),
        (nominalExponent, qtyExponent, priceExponent, rateExponent, rateSign, side, marginCurrency) => {
            const sizeExponent = nominalExponent - qtyExponent;
            fc.pre(sizeExponent >= -1074 && nominalExponent - priceExponent <= 1023);
            const input = inversePerpInput({
                side, marginCurrency,
                qtyBase: 2 ** qtyExponent, contractSizeUsd: 2 ** sizeExponent,
                notionalQuote: 2 ** nominalExponent,
                entryPrice: 2 ** priceExponent, currentPrice: 2 ** priceExponent, exitPriceQuote: 2 ** priceExponent,
                margin: { mode: 'isolated', rules: null },
                costs: { ...inversePerpInput().costs, fundingRatePerInterval: rateSign * 2 ** rateExponent },
            });
            const raw = buildRiskReport(input);
            const serialized = JSON.parse(JSON.stringify(raw, (_key, value: unknown) => {
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            })) as RiskReport;
            // Independent exact oracle: contract count and USD size are powers
            // of two. Price must not occur in the sum of funding exponents.
            const magnitude = 2 ** (nominalExponent + rateExponent);
            for (const report of [raw, serialized]) {
                const metrics = new Map(allMetrics(report).map((block) => [block.metricKey, block]));
                expect(metrics.get('entryNotionalQuote')).toMatchObject({
                    value: 2 ** nominalExponent, unit: 'quote_currency', status: 'valid',
                });
                const funding = metrics.get('holdingCostPerIntervalQuote');
                if (rateSign !== 0 && magnitude === 0) {
                    expect(funding).toMatchObject({ value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' });
                    expect(report.reportStatus).toBe('calculation_error');
                } else {
                    const expected = rateSign === 0 ? 0 : (side === 'LONG' ? 1 : -1) * rateSign * magnitude;
                    expect(funding).toMatchObject({ value: expected, unit: 'quote_currency', status: 'valid' });
                    expect(report.reportStatus).toBe('insufficient_data');
                }
                expect(report.marginViolation.detected).toBeNull();
            }
        },
    ), { numRuns: 1000, examples: [
        [0, 700, 0, -700, 1, 'LONG', 'base'],
        [1000, 1000, 0, -1074, -1, 'SHORT', 'quote'],
        [-300, 500, 0, -1000, -1, 'LONG', 'base'],
    ] });
});
