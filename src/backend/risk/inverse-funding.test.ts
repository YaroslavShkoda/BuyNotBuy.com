import { describe, expect, it } from 'vitest';
import type { RiskReport } from '../types/risk.js';
import { allMetrics, inversePerpInput, linearPerpInput, reviewedLinearRules } from './fixtures.js';
import { buildRiskReport } from './report.js';
import type { RiskInput } from './schema.js';
import { RiskInputSchema } from './schema.js';

function inverse(overrides: Partial<RiskInput> = {}): RiskInput {
    return inversePerpInput({
        qtyBase: 100, contractSizeUsd: 10, marginCurrency: 'base',
        notionalQuote: 1000, currentPrice: 45000,
        margin: { mode: 'isolated', rules: null },
        costs: { ...linearPerpInput().costs, fundingRatePerInterval: 0.001 },
        ...overrides,
    });
}

function reports(input: RiskInput): readonly RiskReport[] {
    const raw = buildRiskReport(input);
    const json = JSON.stringify(raw, (_key, value: unknown) => {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        return value;
    });
    const serialized = JSON.parse(json) as RiskReport;
    for (const report of [raw, serialized]) {
        for (const block of allMetrics(report)) {
            if (block.status === 'valid') {
                expect(block.value).not.toBeNull();
                expect(Number.isFinite(block.value)).toBe(true);
            }
        }
    }
    return [raw, serialized];
}

function metricByKey(report: RiskReport, key: string) {
    const block = report.positionRisk.metrics.find((candidate) => candidate.metricKey === key);
    expect(block).toBeDefined();
    return block!;
}

describe('USD inverse funding', () => {
    it.each(['LONG', 'SHORT'] as const)('values 100 contracts x 10 USD at 1 USD per interval for %s', (side) => {
        for (const marginCurrency of ['base', 'quote', null] as const) {
            for (const report of reports(inverse({ side, marginCurrency }))) {
                expect(metricByKey(report, 'entryNotionalQuote')).toMatchObject({
                    value: 1000, unit: 'quote_currency', status: 'valid',
                });
                expect(metricByKey(report, 'holdingCostPerIntervalQuote')).toMatchObject({
                    value: side === 'LONG' ? 1 : -1, unit: 'quote_currency', status: 'valid', reasonCode: null,
                });
                // Margin rules are absent: correct funding does not invent a liquidation model.
                expect(report.reportStatus).toBe('insufficient_data');
                expect(report.marginViolation.detected).toBeNull();
            }
        }
    });

    it.each(['LONG', 'SHORT'] as const)('keeps zero funding zero and reverses negative funding for %s', (side) => {
        for (const rate of [0, -0.001]) {
            for (const report of reports(inverse({ side, costs: { ...linearPerpInput().costs, fundingRatePerInterval: rate } }))) {
                expect(metricByKey(report, 'holdingCostPerIntervalQuote')).toMatchObject({
                    value: rate === 0 ? 0 : side === 'LONG' ? -1 : 1,
                    unit: 'quote_currency', status: 'valid',
                });
            }
        }
    });

    it('keeps missing funding unknown, with its warning and aggregate status', () => {
        for (const report of reports(inverse({ costs: { ...linearPerpInput().costs, fundingRatePerInterval: null } }))) {
            expect(metricByKey(report, 'holdingCostPerIntervalQuote')).toMatchObject({
                value: null, status: 'degraded', reasonCode: 'UNKNOWN_FUNDING',
            });
            expect(report.warnings.some((warning) => warning.code === 'UNKNOWN_FUNDING')).toBe(true);
            expect(report.reportStatus).toBe('insufficient_data');
        }
    });

    it.each([0, 0.001])('refuses to borrow unchecked notional when size is missing and rate is %s', (rate) => {
        for (const report of reports(inverse({ contractSizeUsd: null, costs: { ...linearPerpInput().costs, fundingRatePerInterval: rate } }))) {
            for (const key of ['entryNotionalQuote', 'holdingCostPerIntervalQuote']) {
                expect(metricByKey(report, key)).toMatchObject({
                    value: null, status: 'insufficient_data', reasonCode: 'MISSING_INVERSE_CONTRACT_PARAMS',
                });
            }
        }
    });

    it('does not let current price change the fixed USD funding nominal', () => {
        for (const currentPrice of [1e-300, 45000, 1e308]) {
            for (const report of reports(inverse({ currentPrice }))) {
                expect(metricByKey(report, 'holdingCostPerIntervalQuote')).toMatchObject({ value: 1, status: 'valid' });
            }
        }
    });

    it('retains tiny funding rescued by contract count, and funding on an extreme finite nominal', () => {
        for (const values of [
            { qtyBase: 1e200, contractSizeUsd: 1e-200, notionalQuote: 1, rate: 1e-200, expected: 1e-200 },
            { qtyBase: 1e303, contractSizeUsd: 1e5, notionalQuote: 1e308, rate: 1e-308, expected: 1 },
        ]) {
            for (const report of reports(inverse({
                qtyBase: values.qtyBase, contractSizeUsd: values.contractSizeUsd,
                notionalQuote: values.notionalQuote, currentPrice: 40000, exitPriceQuote: 40000,
                costs: { ...linearPerpInput().costs, fundingRatePerInterval: values.rate },
            }))) {
                const funding = metricByKey(report, 'holdingCostPerIntervalQuote');
                expect(funding.status).toBe('valid');
                expect(funding.value! / values.expected).toBeCloseTo(1, 14);
                expect(report.reportStatus).toBe('insufficient_data');
            }
        }
    });

    it('propagates a nonzero funding payment below the representable range as an error', () => {
        for (const report of reports(inverse({
            qtyBase: 1, contractSizeUsd: 1e-100, notionalQuote: 1e-100,
            currentPrice: 40000, exitPriceQuote: 40000,
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: -1e-300 },
        }))) {
            expect(metricByKey(report, 'holdingCostPerIntervalQuote')).toMatchObject({
                value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW',
            });
            expect(report.positionRisk.status).toBe('calculation_error');
            expect(report.reportStatus).toBe('calculation_error');
            expect(report.marginViolation.detected).toBeNull();
        }
    });
});

describe('inverse currency validation', () => {
    it.each([
        ['ETHBTC', 'BTC'], ['BTCUSDT', 'USDT'], ['BTCUSDC', 'USDC'], ['BTCEUR', 'EUR'],
    ])('rejects %s quote %s without an FX source', (ticker, quoteCurrency) => {
        const input = inverse({ ticker, quoteCurrency, atr: { ...inverse().atr, symbol: ticker } });
        const result = RiskInputSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((issue) => issue.path.join('.') === 'quoteCurrency' && issue.message.includes('no FX conversion'))).toBe(true);
        }
        expect(() => buildRiskReport(input)).toThrow();
    });

    it('also refuses non-USD quote while the inverse specification is missing', () => {
        const input = inverse({ ticker: 'ETHBTC', quoteCurrency: 'BTC', contractSizeUsd: null, atr: { ...inverse().atr, symbol: 'ETHBTC' } });
        expect(RiskInputSchema.safeParse(input).success).toBe(false);
    });

    it('refuses a USD quote label on a ticker with another quote, and contradictory notional', () => {
        expect(RiskInputSchema.safeParse(inverse({ ticker: 'ETHBTC', atr: { ...inverse().atr, symbol: 'ETHBTC' } })).success).toBe(false);
        expect(RiskInputSchema.safeParse(inverse({ notionalQuote: 4500000 })).success).toBe(false);
    });

    it('rejects an overflowing USD nominal instead of publishing a valid funding estimate', () => {
        const input = inverse({ qtyBase: 1e308, contractSizeUsd: 1e308, notionalQuote: 1e308 });
        const result = RiskInputSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((issue) => issue.path.join('.') === 'notionalQuote')).toBe(true);
        }
        expect(() => buildRiskReport(input)).toThrow();
    });

    it('keeps ordinary and non-USD linear funding in their existing quote units', () => {
        for (const report of reports(linearPerpInput())) {
            expect(metricByKey(report, 'holdingCostPerIntervalQuote').value).toBeCloseTo(2.05, 14);
            expect(report.reportStatus).toBe('valid');
        }
        const input = linearPerpInput({
            ticker: 'ETHBTC', quoteCurrency: 'BTC', qtyBase: 2,
            entryPrice: 0.05, currentPrice: 0.06, notionalQuote: 0.1, collateralQuote: 0.01,
            atr: { ...linearPerpInput().atr, symbol: 'ETHBTC' },
            margin: { mode: 'isolated', rules: reviewedLinearRules({ collateralCurrency: 'BTC' }) },
            costs: { ...linearPerpInput().costs, fundingRatePerInterval: 0.001 },
        });
        for (const report of reports(input)) {
            expect(metricByKey(report, 'holdingCostPerIntervalQuote').value).toBeCloseTo(0.00012, 14);
            expect(metricByKey(report, 'holdingCostPerIntervalQuote').unit).toBe('quote_currency');
        }
    });
});
