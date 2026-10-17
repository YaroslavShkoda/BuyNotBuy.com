import { describe, expect, it } from 'vitest';
import {
    allMetrics,
    inversePerpInput,
    LAST_BAR,
    linearPerpInput,
    reviewedInverseRules,
    reviewedLinearRules,
    spotInput,
} from './fixtures.js';
import { buildRiskReport } from './report.js';
import type { RiskInput } from './schema.js';

/**
 * The report suites read like an operator's checklist: for every hand-chosen
 * input, what the report must say, with numbers derived on paper from the
 * baseline (qty 0.5, entry 40000, current 41000, collateral 4000, mmr 0.01).
 */

const build = (input: RiskInput) => buildRiskReport(input);

const baselineReport = () => build(linearPerpInput());

describe('the baseline linear-perpetual report', () => {
    it('publishes hand-checked position risk numbers', () => {
        const report = baselineReport();
        const byKey = new Map(report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]));

        expect(byKey.get('unrealizedPnlQuote')?.value).toBeCloseTo(500, 9);
        expect(byKey.get('unrealizedPnlPercentOfEntryNotional')?.value).toBeCloseTo(2.5, 9);
        expect(byKey.get('returnOnMarginPercent')?.value).toBeCloseTo(12.5, 9);
        expect(byKey.get('holdingCostPerIntervalQuote')?.value).toBeCloseTo(2.05, 9);
    });

    it('finds no margin violation, with the arithmetic it came from', () => {
        const { marginViolation } = baselineReport();

        expect(marginViolation.detected).toBe(false);
        expect(marginViolation.atBar).toBeNull();
        expect(marginViolation.equityQuote).toBeCloseTo(4500, 9);
        expect(marginViolation.maintenanceRequirementQuote).toBeCloseTo(205, 9);
        expect(marginViolation.status).toBe('valid');
    });

    it('reports a detected violation at the assessed bar when equity falls short', () => {
        const report = build(linearPerpInput({ currentPrice: 30000, notionalQuote: 20000 }));
        const { marginViolation } = report;

        // equity = 4000 + (30000 - 40000) * 0.5 = -1000; requirement = 150.
        expect(marginViolation.detected).toBe(true);
        expect(marginViolation.atBar).toBe(LAST_BAR);
        expect(marginViolation.equityQuote).toBeCloseTo(-1000, 9);
    });

    it('carries the hand-checked liquidation estimate and both distances', () => {
        const report = baselineReport();
        const { liquidationConsequences, distances } = report;

        expect(liquidationConsequences.point.liquidationPriceQuote).toBeCloseTo(
            32323.232323232323,
            6,
        );
        expect(liquidationConsequences.point.projectedLossQuote).toBeCloseTo(3838.383838383838, 6);
        expect(liquidationConsequences.status).toBe('valid');

        expect(distances.percentDistance.value).toBeCloseTo(21.16284799211628, 6);
        expect(distances.atrDistance.value).toBeCloseTo(10.58142399605814, 6);
        expect(distances.atr.value).toBe(0.02);
    });
});

describe('a spot position is answered only where the question applies', () => {
    it('marks margin, funding and liquidation not_applicable and computes pnl', () => {
        const report = build(spotInput());

        expect(report.marginViolation.status).toBe('not_applicable');
        expect(report.marginViolation.detected).toBeNull();

        const holding = report.positionRisk.metrics.find(
            (entry) => entry.metricKey === 'holdingCostPerIntervalQuote',
        );

        expect(holding?.status).toBe('not_applicable');
        expect(holding?.reasonCode).toBe('FUNDING_NOT_APPLICABLE');
        expect(holding?.value).toBeNull();

        expect(report.liquidationConsequences.status).toBe('not_applicable');
        expect(report.distances.percentDistance.status).toBe('not_applicable');
        expect(report.distances.atrDistance.status).toBe('not_applicable');

        const pnl = report.positionRisk.metrics.find(
            (entry) => entry.metricKey === 'unrealizedPnlQuote',
        );

        expect(pnl?.status).toBe('valid');
        expect(pnl?.value).toBeCloseTo(500, 9);
        expect(
            report.positionRisk.metrics.some((entry) => entry.metricKey === 'returnOnMarginPercent'),
        ).toBe(false);

        expect(report.reportStatus).toBe('valid');
    });
});

describe('funding absence degrades exactly the dependent metrics', () => {
    it('degrades holding cost with a diagnostic, leaving the rest valid', () => {
        const report = build(
            linearPerpInput({
                costs: { ...linearPerpInput().costs, fundingRatePerInterval: null },
            }),
        );

        const holding = report.positionRisk.metrics.find(
            (entry) => entry.metricKey === 'holdingCostPerIntervalQuote',
        );

        expect(holding?.status).toBe('degraded');
        expect(holding?.reasonCode).toBe('UNKNOWN_FUNDING');
        expect(holding?.value).toBeNull();

        const pnl = report.positionRisk.metrics.find(
            (entry) => entry.metricKey === 'unrealizedPnlQuote',
        );

        expect(pnl?.status).toBe('valid');

        expect(
            report.warnings.some(
                (warning) =>
                    warning.code === 'UNKNOWN_FUNDING' &&
                    warning.metricKey === 'holdingCostPerIntervalQuote',
            ),
        ).toBe(true);

        expect(report.reportStatus).toBe('degraded');
    });
});

describe('margin rules gate liquidation, never the market metrics', () => {
    it('answers insufficient_data for violation and liquidation when rules are absent', () => {
        const report = build(linearPerpInput({ margin: { mode: 'isolated', rules: null } }));

        expect(report.marginViolation.status).toBe('insufficient_data');
        expect(report.marginViolation.reasonCode).toBe('MARGIN_RULES_MISSING');
        expect(report.marginViolation.detected).toBeNull();

        expect(report.liquidationConsequences.status).toBe('insufficient_data');
        expect(report.liquidationConsequences.point.liquidationPriceQuote).toBeNull();
        expect(report.distances.percentDistance.value).toBeNull();

        expect(report.positionRisk.status).toBe('valid');
    });

    it('never calls a draft-config estimate valid', () => {
        const report = build(
            linearPerpInput({
                margin: { mode: 'isolated', rules: reviewedLinearRules({ reviewStatus: 'draft' }) },
            }),
        );

        expect(report.liquidationConsequences.status).toBe('degraded');
        expect(report.liquidationConsequences.reasonCode).toBe('MARGIN_RULES_DRAFT');
        expect(report.liquidationConsequences.point.liquidationPriceQuote).not.toBeNull();
        expect(report.liquidationConsequences.widthDrivers).toContain('MARGIN_RULES_DRAFT');
        expect(report.reportStatus).toBe('degraded');
    });

    it('refuses cross margin with the precise reason', () => {
        const report = build(
            linearPerpInput({
                margin: { mode: 'cross', rules: reviewedLinearRules({ mode: 'cross' }) },
            }),
        );

        expect(report.marginViolation.detected).toBeNull();
        expect(report.marginViolation.reasonCode).toBe('CROSS_MARGIN_NOT_ASSESSABLE');
        expect(report.liquidationConsequences.reasonCode).toBe('CROSS_MARGIN_NOT_ASSESSABLE');
    });
});

describe('an inverse position without contract parameters', () => {
    const inverse = inversePerpInput({
        positionId: 'test-inverse-001',
        contractKind: 'inverse_perp',
        contractSizeUsd: null,
        marginCurrency: null,
        margin: {
            mode: 'isolated',
            rules: reviewedInverseRules(),
        },
    });    it('answers insufficient_data everywhere the contract spec is required', () => {
        const report = build(inverse);

        const pnl = report.positionRisk.metrics.find(
            (entry) => entry.metricKey === 'unrealizedPnlQuote',
        );

        expect(pnl?.status).toBe('insufficient_data');
        expect(pnl?.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
        expect(pnl?.value).toBeNull();

        expect(report.liquidationConsequences.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
        expect(report.marginViolation.status).toBe('insufficient_data');
        expect(report.reportStatus).toBe('insufficient_data');
    });
});

describe('distances', () => {
    it('keeps percent and ATR distance independent, and a dead ATR yields nothing', () => {
        const report = build(linearPerpInput({ atr: { ...linearPerpInput().atr, value: 0 } }));

        expect(report.distances.percentDistance.status).toBe('valid');
        expect(report.distances.atrDistance.status).toBe('insufficient_data');
        expect(report.distances.atrDistance.reasonCode).toBe('ATR_UNUSABLE');
        expect(report.distances.atrDistance.value).toBeNull();
        expect(report.warnings.some((warning) => warning.code === 'ATR_UNUSABLE')).toBe(true);
    });

    it('lets the percent distance go negative when liquidation is behind the market', () => {
        const report = build(linearPerpInput({ currentPrice: 30000 }));

        expect((report.distances.percentDistance.value ?? 0) < 0).toBe(true);
        expect(report.marginViolation.detected).toBe(true);
    });
});

describe('scenarios keep their provenance and promise nothing', () => {
    it('stores historical and synthetic references apart, as references', () => {
        const report = build(
            linearPerpInput({
                scenarios: [
                    {
                        kind: 'historical',
                        scenarioId: 'hist-2024-08-05',
                        sourceVenue: 'binance',
                        datasetRef: 'binance-1h-2024-08',
                        fromBar: 1_722_800_000_000,
                        toBar: 1_722_900_000_000,
                        assumptions: [],
                    },
                    {
                        kind: 'synthetic',
                        scenarioId: 'synth-crash-30',
                        generatorId: 'gap-shock',
                        generatorVersion: 'gen@1',
                        params: { dropPercent: -30 },
                        assumptions: ['instant gap, no recovery'],
                    },
                ],
            }),
        );

        expect(report.stress.historical).toHaveLength(1);
        expect(report.stress.synthetic).toHaveLength(1);
        expect(report.stress.historical[0]?.kind).toBe('historical');
        expect(report.stress.synthetic[0]?.kind).toBe('synthetic');
        expect(report.stress.status).toBe('degraded');
        expect(report.stress.reasonCode).toBe('STRESS_RESULTS_NOT_COMPUTED');
    });

    it('says not_applicable when no scenario was supplied', () => {
        expect(baselineReport().stress.status).toBe('not_applicable');
        expect(baselineReport().stress.reasonCode).toBe('STRESS_ENGINE_NOT_IMPLEMENTED');
    });
});

describe('honesty of the whole report', () => {
    it('never claims portfolio risk it does not compute', () => {
        const report = baselineReport();

        expect(report.portfolioRisk.status).toBe('not_applicable');
        expect(report.portfolioRisk.reasonCode).toBe('PORTFOLIO_NOT_IMPLEMENTED');
        expect(report.portfolioRisk.metrics).toEqual([]);
    });

    it('lowers the report when data quality says the series is unusable', () => {
        const report = build(
            linearPerpInput({
                dataQuality: {
                    score: 0.4,
                    floor: 0,
                    usable: false,
                    worst: 'gaps',
                    blockedBy: 'gaps',
                    freshness: 'fresh',
                },
            }),
        );

        expect(report.dataQuality.status).toBe('degraded');
        expect(report.dataQuality.reasonCode).toBe('DATA_QUALITY_LOW');
        expect(report.reportStatus).toBe('degraded');
    });

    it('holds the metric invariant across the whole report: no valid status without a value, no non-valid without a reason', () => {
        for (const input of [linearPerpInput(), spotInput()]) {
            const report = build(input);

            for (const entry of allMetrics(report)) {
                if (entry.status === 'valid') {
                    expect(entry.value).not.toBeNull();
                } else {
                    expect(entry.reasonCode).not.toBeNull();
                }
            }
        }
    });

    it('is pure: identical input, identical report; the input is not mutated', () => {
        const input = deepFreeze(linearPerpInput());
        const first = build(input);
        const second = build(input);

        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        expect(first.reportId).toBe(second.reportId);
        expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('keeps computed time apart from market time', () => {
        const report = baselineReport();

        expect(report.computedAt).toBe(LAST_BAR + 60_000);
        expect(report.marketAsOf).toBe(LAST_BAR);
        expect(report.schemaVersion).toBe('risk-report/1');
    });
});

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value as object)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }

        Object.freeze(value);
    }

    return value;
}
