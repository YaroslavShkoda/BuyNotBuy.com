import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runRiskReportCli } from '../research/risk-report.cli.js';
import { allMetrics, inversePerpInput, linearPerpInput, reviewedLinearRules, spotInput } from './fixtures.js';
import { potentialPnl } from './position-math.js';
import { buildRiskReport } from './report.js';
import { RiskInputSchema } from './schema.js';
import { add, cmp, div, fromNumber, mul, rounded, sub } from './test-support/fraction-oracle.js';

const failure = { value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' } as const;
const sides = ['LONG', 'SHORT'] as const;

describe('Stage 2.3.2 audit regressions', () => {
    for (const contractKind of ['linear_perp', 'spot'] as const) {
        it.each(sides)(`F1: ${contractKind} %s preserves exact PnL despite quote underflow`, (side) => {
            const result = potentialPnl({
                contractKind, side, qtyBase: Number.MIN_VALUE, entryPrice: 1,
                currentPrice: 1.5, exitPrice: 1.5, contractSizeUsd: null, marginCurrency: null,
            });
            expect(result.quote).toEqual(failure);
            expect(result.percent).toEqual({ value: side === 'LONG' ? 50 : -50, status: 'valid', reasonCode: null });
        });
    }

    it.each(sides)('F2: %s ROM survives intermediate division underflow', (side) => {
        const report = buildRiskReport(linearPerpInput({
            side, qtyBase: Number.MIN_VALUE, entryPrice: 1, currentPrice: 2,
            notionalQuote: Number.MIN_VALUE, collateralQuote: 2,
        }));
        expect(allMetrics(report).find((m) => m.metricKey === 'returnOnMarginPercent')).toMatchObject({
            value: (side === 'LONG' ? 50 : -50) * Number.MIN_VALUE, status: 'valid', reasonCode: null,
        });
    });

    it.each(sides)('F3: %s compares exact maintenance when published amounts coincide', (side) => {
        const report = buildRiskReport(linearPerpInput({
            side, qtyBase: 0.1, entryPrice: 1, currentPrice: 1,
            notionalQuote: 0.1, collateralQuote: 0.001,
        }));
        expect(report.marginViolation).toMatchObject({
            equityQuote: 0.001, maintenanceRequirementQuote: 0.001,
            detected: true, status: 'valid', reasonCode: null,
        });
    });
});

const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true });
const valid = (value: number) => ({ value, status: 'valid', reasonCode: null });

describe('independent fractions and public regression', () => {
    it('compares quote/percent with the adjacent-float oracle across binary64', () => {
        fc.assert(fc.property(positive, positive, positive, fc.constantFrom(...sides),
            fc.constantFrom('linear_perp', 'spot'), (qty, entry, exit, side, contractKind) => {
                const pnl = mul(sub(fromNumber(exit), fromNumber(entry)), fromNumber(side === 'LONG' ? qty : -qty));
                const notional = rounded(mul(fromNumber(qty), fromNumber(entry)));
                const actual = potentialPnl({
                    contractKind, side, qtyBase: qty, entryPrice: entry,
                    currentPrice: exit, exitPrice: exit, contractSizeUsd: null, marginCurrency: null,
                });
                expect(actual.quote).toEqual(rounded(pnl));
                expect(actual.percent).toEqual(notional.value === null ? notional
                    : rounded(div(mul(pnl, fromNumber(100)), fromNumber(notional.value))));
                expect(actual.base).toBeNull();
            }), { seed: 232001, numRuns: 1000 });
    });

    it.each([
        [Number.MIN_VALUE, 1, 1.5, null],
        [3 * Number.MIN_VALUE, 1, 1.5, 2 * Number.MIN_VALUE],
        [5 * Number.MIN_VALUE, 1, 1.5, 2 * Number.MIN_VALUE],
        [2 ** -1022, Number.MIN_VALUE, 1, 2 ** -1022],
        [Number.MAX_VALUE, 1, 3, null],
    ])('handles PnL ties, subnormal and overflow: qty %s entry %s exit %s', (qty, entry, exit, value) => {
        for (const side of sides) {
            const actual = potentialPnl({
                contractKind: 'linear_perp', side, qtyBase: qty, entryPrice: entry,
                currentPrice: exit, exitPrice: exit, contractSizeUsd: null, marginCurrency: null,
            });
            expect(actual.quote).toEqual(value === null ? failure : valid(side === 'LONG' ? value : -value));
        }
    });

    it.each(sides)('%s preserves true zero and independently representable percent/ROM after quote overflow', (side) => {
        const unchanged = potentialPnl({
            contractKind: 'spot', side, qtyBase: Number.MIN_VALUE, entryPrice: 1,
            currentPrice: 1, exitPrice: 1, contractSizeUsd: null, marginCurrency: null,
        });
        expect(unchanged.quote).toEqual(valid(0));
        expect(unchanged.percent).toEqual(valid(0));
        expect(Object.is(unchanged.quote.value, -0)).toBe(false);
        const report = buildRiskReport(linearPerpInput({
            side, qtyBase: Number.MAX_VALUE, entryPrice: 1, currentPrice: 3,
            exitPriceQuote: 3, notionalQuote: Number.MAX_VALUE, collateralQuote: Number.MAX_VALUE,
        }));
        const metrics = new Map(allMetrics(report).map((m) => [m.metricKey, m]));
        expect(metrics.get('unrealizedPnlQuote')).toMatchObject(failure);
        expect(metrics.get('unrealizedPnlPercentOfEntryNotional')).toMatchObject(valid(side === 'LONG' ? 200 : -200));
        expect(metrics.get('returnOnMarginPercent')).toMatchObject(valid(side === 'LONG' ? 200 : -200));
        expect(report.positionRisk.status).toBe('calculation_error');
        expect(report.reportStatus).toBe('calculation_error');
    });

    it('checks ROM, exact equity and strict maintenance boundaries independently', () => {
        let accepted = 0;
        fc.assert(fc.property(positive, positive, positive, positive,
            fc.double({ min: Number.MIN_VALUE, max: 0.49, noNaN: true }),
            fc.constantFrom(...sides), (qty, entry, current, collateral, mmr, side) => {
                const notional = rounded(mul(fromNumber(qty), fromNumber(entry)));
                if (notional.value === null) return;
                accepted += 1;
                const pnl = mul(sub(fromNumber(current), fromNumber(entry)), fromNumber(side === 'LONG' ? qty : -qty));
                const equity = add(fromNumber(collateral), pnl);
                const maintenance = mul(mul(fromNumber(mmr), fromNumber(current)), fromNumber(qty));
                const eq = rounded(equity);
                const req = rounded(maintenance);
                const report = buildRiskReport(linearPerpInput({
                    side, qtyBase: qty, entryPrice: entry, currentPrice: current,
                    notionalQuote: notional.value, collateralQuote: collateral,
                    margin: { mode: 'isolated', rules: reviewedLinearRules({ maintenanceMarginRate: mmr, initialMarginRate: 0.5 }) },
                }));
                const rom = rounded(div(mul(pnl, fromNumber(100)), fromNumber(collateral)));
                expect(allMetrics(report).find((m) => m.metricKey === 'returnOnMarginPercent')).toMatchObject(rom);
                const available = eq.status === 'valid' && req.status === 'valid';
                expect(report.marginViolation).toMatchObject({
                    equityQuote: eq.value, maintenanceRequirementQuote: req.value,
                    detected: available ? cmp(equity, maintenance) < 0n : null,
                    status: available ? 'valid' : 'calculation_error',
                    reasonCode: available ? null : 'CALCULATION_OVERFLOW',
                });
            }), { seed: 232002, numRuns: 1000 });
        expect(accepted).toBeGreaterThan(500);
    });

    it.each(sides)('%s handles equality and adjacent collateral at the maintenance boundary', (side) => {
        // All terms are dyadic; equality is exact even with nonzero PnL.
        const entry = side === 'LONG' ? 1.125 : 0.875;
        for (const collateral of [0.25 - 2 ** -55, 0.25, 0.25 + 2 ** -54]) {
            const report = buildRiskReport(linearPerpInput({
                side, qtyBase: 1, entryPrice: entry, currentPrice: 1,
                notionalQuote: entry, collateralQuote: collateral,
                margin: { mode: 'isolated', rules: reviewedLinearRules({ maintenanceMarginRate: 0.125, initialMarginRate: 0.5 }) },
            }));
            expect(report.marginViolation.detected).toBe(collateral < 0.25);
            expect(report.marginViolation.status).toBe('valid');
        }
    });

    it('uses exact equity even when the independent quote PnL rounds to zero', () => {
        const report = buildRiskReport(linearPerpInput({
            qtyBase: Number.MIN_VALUE, entryPrice: 1, currentPrice: 1.5,
            notionalQuote: Number.MIN_VALUE, collateralQuote: Number.MIN_VALUE,
            margin: { mode: 'isolated', rules: reviewedLinearRules({ maintenanceMarginRate: 0.75, initialMarginRate: 0.875 }) },
        }));
        expect(allMetrics(report).find((m) => m.metricKey === 'unrealizedPnlQuote')).toMatchObject(failure);
        expect(report.marginViolation).toMatchObject({
            equityQuote: 2 * Number.MIN_VALUE, maintenanceRequirementQuote: Number.MIN_VALUE,
            detected: false, status: 'valid',
        });
    });

    it('recovers finite SHORT equity from an unrepresentable quote PnL', () => {
        const report = buildRiskReport(linearPerpInput({
            side: 'SHORT', qtyBase: Number.MAX_VALUE, entryPrice: 1, currentPrice: 3,
            notionalQuote: Number.MAX_VALUE, collateralQuote: Number.MAX_VALUE,
        }));
        expect(allMetrics(report).find((m) => m.metricKey === 'unrealizedPnlQuote')).toMatchObject(failure);
        expect(report.marginViolation).toMatchObject({
            equityQuote: -Number.MAX_VALUE, detected: true, status: 'valid', reasonCode: null,
        });
        expect(report.reportStatus).toBe('calculation_error');
    });

    it.each(sides)('%s safeParse → builder → CLI → JSON preserves statuses and finite public values', (side) => {
        for (const kind of ['linear_perp', 'spot'] as const) {
            const fixture = kind === 'spot' ? spotInput : linearPerpInput;
            const input = RiskInputSchema.parse(fixture({
                side, qtyBase: Number.MIN_VALUE, entryPrice: 1, currentPrice: 1.5,
                exitPriceQuote: 1.5, notionalQuote: Number.MIN_VALUE,
            }));
            const report = buildRiskReport(input);
            const encoded = JSON.stringify(report, (_key, value: unknown) => {
                expect(typeof value).not.toBe('bigint');
                if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
                return value;
            });
            expect(JSON.parse(encoded).reportStatus).toBe('calculation_error');
            expect(report.schemaVersion).toBe('risk-report/1');
            const output: string[] = [];
            expect(runRiskReportCli(['node', 'risk-report', 'input.json'], {
                read: () => JSON.stringify(input), write: (s) => { output.push(s); },
                error: (s) => { throw new Error(s); },
            })).toBe(0);
            expect(JSON.parse(output.join(''))).toEqual(JSON.parse(encoded));
        }
    });

    it('retains draft, cross, inverse and missing-rule gates', () => {
        expect(buildRiskReport(linearPerpInput({ margin: { mode: 'isolated', rules: reviewedLinearRules({ reviewStatus: 'draft' }) } })).marginViolation)
            .toMatchObject({ status: 'degraded', reasonCode: 'MARGIN_RULES_DRAFT' });
        expect(buildRiskReport(linearPerpInput({ margin: { mode: 'cross', rules: reviewedLinearRules({ mode: 'cross' }) } })).marginViolation)
            .toMatchObject({ detected: null, reasonCode: 'CROSS_MARGIN_NOT_ASSESSABLE' });
        expect(buildRiskReport(linearPerpInput({ margin: { mode: 'isolated', rules: null } })).marginViolation)
            .toMatchObject({ detected: null, reasonCode: 'MARGIN_RULES_MISSING' });
        const inverse = buildRiskReport(inversePerpInput({ contractSizeUsd: 100, marginCurrency: 'base', notionalQuote: 50 }));
        expect(inverse.marginViolation).toMatchObject({ detected: null, reasonCode: 'MISSING_INVERSE_CONTRACT_PARAMS' });
        expect(inverse.liquidationConsequences.point.liquidationPriceQuote).toBeNull();
    });
});
