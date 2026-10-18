import { describe, expect, it } from 'vitest';
import {
    inversePerpInput,
    linearPerpInput,
    reviewedInverseRules,
    spotInput,
} from './fixtures.js';
import {
    absoluteExposureBaseUnits,
    absoluteNotionalQuote,
    directedExposureQuote,
    estimatedRoundTripCost,
    invalidationAtrDistance,
    invalidationDistance,
    potentialPnl,
} from './position-math.js';
import { buildRiskReport } from './report.js';

/**
 * Every expected number below was computed by hand from the formula under
 * test, not read back from the implementation.
 *
 * Baseline quantities, shared with the bundled fixture:
 *   qty 0.5, entry 40000, current 41000, exit 39000, atr 0.02,
 *   costs: taker 0.001, spread 0.0002, slippage 0.0005, reserve 0.0005.
 *
 * Inverse example: 10 contracts of size 100, entry 40000, current 41000:
 *   notional = 10 x 100 = 1000; base exposure = 1000 / 40000 = 0.025;
 *   long, exit 39000: base = 1000 x (1/40000 - 1/39000) = -0.0006410256...;
 *   quote = base x 41000 = -26.2820512...;
 *   short, exit 41000: base = -1000 x (1/40000 - 1/41000) = -0.0006097560...;
 *   quote = -25.0000000...
 */

const linearSpec = {
    contractKind: 'linear_perp',
    side: 'LONG',
    qtyBase: 0.5,
    entryPrice: 40000,
    contractSizeUsd: null,
    marginCurrency: null,
} as const;

const inverseSpec = {
    contractKind: 'inverse_perp',
    side: 'LONG',
    qtyBase: 10,
    entryPrice: 40000,
    contractSizeUsd: 100,
    marginCurrency: 'base',
} as const;

const baselineCosts = {
    takerFeeRate: 0.001,
    spreadRate: 0.0002,
    slippageRate: 0.0005,
    executionReserveRate: 0.0005,
};

describe('absolute notional', () => {
    it('is qty x entry for spot and linear', () => {
        expect(absoluteNotionalQuote(linearSpec).value).toBe(20000);
        expect(
            absoluteNotionalQuote({ ...linearSpec, contractKind: 'spot' }).value,
        ).toBe(20000);
    });

    it('is contracts x confirmed size for the inverse', () => {
        expect(absoluteNotionalQuote(inverseSpec).value).toBe(1000);
    });

    it('answers insufficient_data for an inverse without a confirmed size', () => {
        const result = absoluteNotionalQuote({
            ...inverseSpec,
            contractSizeUsd: null,
        });

        expect(result.value).toBeNull();
        expect(result.status).toBe('insufficient_data');
        expect(result.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
    });

    it('stays finite at the extremes the schema allows', () => {
        expect(
            absoluteNotionalQuote({
                ...inverseSpec,
                qtyBase: 1e-6,
                contractSizeUsd: 1e6,
            }).value,
        ).toBe(1);
        expect(
            absoluteNotionalQuote({ ...linearSpec, entryPrice: 1e6 }).value,
        ).toBe(500000);
    });

    it('answers calculation_error when the notional overflows the doubles', () => {
        const result = absoluteNotionalQuote({
            ...inverseSpec,
            qtyBase: 1e300,
            contractSizeUsd: 1e300,
        });

        expect(result.value).toBeNull();
        expect(result.status).toBe('calculation_error');
        expect(result.reasonCode).toBe('CALCULATION_OVERFLOW');
    });
});

describe('base-units exposure', () => {
    it('is the raw quantity for spot and linear', () => {
        expect(absoluteExposureBaseUnits(linearSpec).value).toBe(0.5);
    });

    it('is the notional re-priced into base for the inverse', () => {
        expect(absoluteExposureBaseUnits(inverseSpec).value).toBe(0.025);
    });

    it('refuses an inverse exposure without the confirmed size', () => {
        expect(
            absoluteExposureBaseUnits({ ...inverseSpec, contractSizeUsd: null })
                .reasonCode,
        ).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
    });
});

describe('directed exposure', () => {
    it('is positive for a long and negative for a short, same magnitude', () => {
        expect(directedExposureQuote(linearSpec).value).toBe(20000);
        expect(directedExposureQuote({ ...linearSpec, side: 'SHORT' }).value).toBe(
            -20000,
        );
    });

    it('carries the inverse size in quote currency, signed', () => {
        expect(directedExposureQuote(inverseSpec).value).toBe(1000);
        expect(directedExposureQuote({ ...inverseSpec, side: 'SHORT' }).value).toBe(
            -1000,
        );
    });

    it('propagates the inverse data gap instead of a signed zero', () => {
        const result = directedExposureQuote({
            ...inverseSpec,
            contractSizeUsd: null,
        });

        expect(result.value).toBeNull();
        expect(result.status).toBe('insufficient_data');
    });
});

describe('potential PnL for spot and linear', () => {
    const args = {
        ...linearSpec,
        currentPrice: 41000,
        exitPrice: 39000,
    };

    it('pays a long when price rises and charges it when price falls', () => {
        expect(potentialPnl({ ...args, exitPrice: 41000 }).quote.value).toBe(500);
        expect(potentialPnl(args).quote.value).toBe(-500);
    });

    it('mirrors every number for a short', () => {
        const short = { ...args, side: 'SHORT' as const };

        expect(potentialPnl({ ...short, exitPrice: 39000 }).quote.value).toBe(500);
        expect(potentialPnl({ ...short, exitPrice: 41000 }).quote.value).toBe(-500);
    });

    it('is exactly zero at the entry price, not an error, for both sides', () => {
        for (const side of ['LONG', 'SHORT'] as const) {
            const flat = potentialPnl({ ...args, side, exitPrice: 40000 });

            expect(flat.quote.value).toBe(0);
            expect(Object.is(flat.quote.value, -0)).toBe(false);
            expect(flat.quote.status).toBe('valid');
            expect(flat.percent.value).toBe(0);
            expect(Object.is(flat.percent.value, -0)).toBe(false);
        }
    });

    it('measures percent against the entry notional', () => {
        expect(potentialPnl(args).percent.value).toBeCloseTo(-2.5, 12);
        expect(
            potentialPnl({ ...args, side: 'SHORT', exitPrice: 41000 }).percent
                .value,
        ).toBeCloseTo(-2.5, 12);
    });

    it('has no base-denominated figure: the quote is the native currency', () => {
        expect(potentialPnl(args).base).toBeNull();
    });

    it('answers not_applicable when no exit price was asked', () => {
        const result = potentialPnl({ ...args, exitPrice: null });

        expect(result.quote.value).toBeNull();
        expect(result.quote.status).toBe('not_applicable');
        expect(result.quote.reasonCode).toBe('EXIT_PRICE_NOT_PROVIDED');
        expect(result.percent.reasonCode).toBe('EXIT_PRICE_NOT_PROVIDED');
        expect(result.base?.status).toBe('not_applicable');
    });
});

describe('potential PnL for the inverse contract', () => {
    const args = {
        ...inverseSpec,
        currentPrice: 41000,
        exitPrice: 39000,
    };

    it('gains base units when price falls for a long, and loses when it rises', () => {
        const falling = potentialPnl(args);
        const rising = potentialPnl({ ...args, exitPrice: 41000 });

        expect(falling.base?.value).toBeCloseTo(-0.000641025641025641, 15);
        expect(rising.base?.value).toBeCloseTo(0.0006097560975609757, 15);
    });

    it('mirrors the sign for a short', () => {
        const short = potentialPnl({ ...args, side: 'SHORT' });

        expect(short.base?.value).toBeCloseTo(0.000641025641025641, 15);
    });

    it('converts to quote at the current price, explicitly', () => {
        const falling = potentialPnl(args);

        expect(falling.quote.value).toBeCloseTo(-26.282051282051283, 9);
    });

    it('answers the auditor scenario end to end', () => {
        // 10 contracts x 100, entry 40000, exit 39000, current 41000.
        const result = potentialPnl(args);

        expect(result.base?.value).toBeCloseTo(-0.000641025641025641, 15);
        expect(result.quote.value).toBeCloseTo(-26.282051282051283, 9);
        expect(result.percent.value).toBeCloseTo(-2.6282051282051283, 12);
        expect(result.percent.status).toBe('valid');
    });

    it('takes the percent from the confirmed USD notional, not qty x entry', () => {
        const result = potentialPnl(args);

        expect(result.quote.value).toBeCloseTo(-26.282051282051283, 9);
        expect(result.percent.value).toBeCloseTo(
            ((result.quote.value ?? 0) / 1000) * 100,
            12,
        );
    });

    it('charges a short inverse when price rises', () => {
        const losing = potentialPnl({
            ...args,
            side: 'SHORT',
            exitPrice: 41000,
        });

        expect(losing.base?.value).toBeCloseTo(-0.0006097560975609756, 15);
        expect(losing.quote.value).toBeCloseTo(-25, 9);
        expect(losing.percent.value).toBeCloseTo(-2.5, 12);
    });

    it('keeps the base figure only when the contract settles in base', () => {
        const quoteMargined = potentialPnl({ ...args, marginCurrency: 'quote' });

        expect(quoteMargined.base?.value).toBeNull();
        expect(quoteMargined.base?.status).toBe('not_applicable');
        expect(quoteMargined.base?.reasonCode).toBe(
            'INVERSE_SETTLEMENT_NOT_BASE',
        );
        expect(quoteMargined.quote.status).toBe('valid');
        expect(quoteMargined.percent.status).toBe('valid');
    });

    it('refuses every figure while the specification is incomplete', () => {
        const result = potentialPnl({ ...args, marginCurrency: null });

        expect(result.quote.value).toBeNull();
        expect(result.quote.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
        expect(result.percent.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
        expect(result.base?.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
    });

    it('answers calculation_error when the percent overflows', () => {
        const result = potentialPnl({
            contractKind: 'inverse_perp',
            side: 'LONG',
            qtyBase: 1,
            entryPrice: 1,
            contractSizeUsd: 1e-300,
            marginCurrency: 'base',
            currentPrice: 1e307,
            exitPrice: 2,
        });

        expect(result.quote.status).toBe('valid');
        expect(result.base?.status).toBe('valid');
        expect(result.percent.value).toBeNull();
        expect(result.percent.status).toBe('calculation_error');
        expect(result.percent.reasonCode).toBe('CALCULATION_OVERFLOW');
    });

    it('never borrows the linear formula when the size is unconfirmed', () => {
        const result = potentialPnl({ ...args, contractSizeUsd: null });

        expect(result.quote.value).toBeNull();
        expect(result.quote.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
        expect(result.base?.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
    });

    it('answers not_applicable without an exit price, even with a full spec', () => {
        const result = potentialPnl({ ...args, exitPrice: null });

        expect(result.quote.reasonCode).toBe('EXIT_PRICE_NOT_PROVIDED');
        expect(result.base?.value).toBeNull();
    });
});

describe('distance to the invalidation level', () => {
    it('measures downward from entry for a long', () => {
        const result = invalidationDistance({
            side: 'LONG',
            entryPrice: 40000,
            levelQuote: 38000,
        });

        expect(result.absolute.value).toBe(2000);
        expect(result.percent.value).toBeCloseTo(5, 12);
    });

    it('measures upward from entry for a short', () => {
        const result = invalidationDistance({
            side: 'SHORT',
            entryPrice: 40000,
            levelQuote: 42000,
        });

        expect(result.absolute.value).toBe(2000);
        expect(result.percent.value).toBeCloseTo(5, 12);
    });

    it('reports an honest zero for a level exactly at entry', () => {
        for (const side of ['LONG', 'SHORT'] as const) {
            const result = invalidationDistance({
                side,
                entryPrice: 40000,
                levelQuote: 40000,
            });

            expect(result.absolute.value).toBe(0);
            expect(result.absolute.status).toBe('valid');
            expect(result.percent.value).toBe(0);
        }
    });

    it('refuses a level on the favorable side instead of a negative distance', () => {
        for (const [side, level] of [
            ['LONG', 40100],
            ['SHORT', 39900],
        ] as const) {
            const result = invalidationDistance({
                side,
                entryPrice: 40000,
                levelQuote: level,
            });

            expect(result.absolute.value).toBeNull();
            expect(result.absolute.reasonCode).toBe(
                'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
            );
            expect(result.percent.reasonCode).toBe(
                'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
            );
        }
    });

    it('answers not_applicable when no level was provided', () => {
        const result = invalidationDistance({
            side: 'LONG',
            entryPrice: 40000,
            levelQuote: null,
        });

        expect(result.absolute.value).toBeNull();
        expect(result.absolute.reasonCode).toBe('INVALIDATION_LEVEL_NOT_PROVIDED');
    });

    it('stays finite at extreme scales', () => {
        const huge = invalidationDistance({
            side: 'LONG',
            entryPrice: 1e6,
            levelQuote: 1,
        });
        const tiny = invalidationDistance({
            side: 'LONG',
            entryPrice: 0.0001,
            levelQuote: 0.00005,
        });

        expect(huge.absolute.value).toBe(999999);
        expect(huge.percent.value).toBeCloseTo(99.9999, 9);
        expect(tiny.absolute.value).toBeCloseTo(0.00005, 12);
        expect(tiny.percent.value).toBeCloseTo(50, 9);
    });

    it('answers calculation_error when the percent overflows', () => {
        // A short's adverse side is upward, so the level can sit arbitrarily
        // far from a tiny entry while staying consistent with the side.
        const result = invalidationDistance({
            side: 'SHORT',
            entryPrice: 1e-300,
            levelQuote: 1e308,
        });

        expect(result.absolute.status).toBe('valid');
        expect(result.percent.value).toBeNull();
        expect(result.percent.status).toBe('calculation_error');
        expect(result.percent.reasonCode).toBe('CALCULATION_OVERFLOW');
    });
});

describe('ATR distance to the invalidation level', () => {
    const args = {
        side: 'LONG',
        entryPrice: 40000,
        levelQuote: 38000,
    } as const;

    it('divides the absolute distance by atr x entry', () => {
        const result = invalidationAtrDistance({ ...args, atrValue: 0.02 });

        expect(result.value).toBeCloseTo(2.5, 12);
        expect(result.status).toBe('valid');
    });

    it('refuses a zero, negative or non-finite ATR', () => {
        for (const atrValue of [0, -0.01, Number.NaN]) {
            const result = invalidationAtrDistance({ ...args, atrValue });

            expect(result.value).toBeNull();
            expect(result.reasonCode).toBe('ATR_UNUSABLE');
        }
    });

    it('answers the level question before the ATR question', () => {
        const result = invalidationAtrDistance({
            ...args,
            levelQuote: null,
            atrValue: 0,
        });

        expect(result.reasonCode).toBe('INVALIDATION_LEVEL_NOT_PROVIDED');
    });

    it('carries the contradiction before the ATR question too', () => {
        const result = invalidationAtrDistance({
            ...args,
            levelQuote: 42000,
            atrValue: 0,
        });

        expect(result.reasonCode).toBe('INVALIDATION_LEVEL_CONTRADICTS_SIDE');
    });

    it('stays finite when the ATR is minuscule', () => {
        const result = invalidationAtrDistance({ ...args, atrValue: 1e-9 });

        expect(result.value).toBeCloseTo(5e7, 3);
    });

    it('recovers a representable ATR distance when the normalization product overflows', () => {
        const result = invalidationAtrDistance({
            side: 'LONG',
            entryPrice: 1e300,
            levelQuote: 1e299,
            atrValue: 1e300,
        });

        expect(result.value! / 9e-301).toBeCloseTo(1, 12);
        expect(result.status).toBe('valid');
        expect(result.reasonCode).toBeNull();
    });
});

describe('round-trip execution cost', () => {
    it('is two legs of taker + half spread + slippage + reserve', () => {
        const result = estimatedRoundTripCost(20000, baselineCosts);

        expect(result.quote.value).toBeCloseTo(84, 9);
        expect(result.percent.value).toBeCloseTo(0.42, 12);
    });

    it('treats provided zero rates as a valid zero, not missing data', () => {
        const result = estimatedRoundTripCost(20000, {
            takerFeeRate: 0,
            spreadRate: 0,
            slippageRate: 0,
            executionReserveRate: 0,
        });

        expect(result.quote.value).toBe(0);
        expect(result.quote.status).toBe('valid');
    });

    it('scales with the notional it is estimated on', () => {
        expect(
            estimatedRoundTripCost(1, baselineCosts).quote.value,
        ).toBeCloseTo(0.0042, 15);
    });

    it('throws on a notional that cannot exist', () => {
        expect(() => estimatedRoundTripCost(0, baselineCosts)).toThrow(
            RangeError,
        );
    });

    it('throws on a rate that is not a finite number', () => {
        for (const broken of [Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() =>
                estimatedRoundTripCost(20000, {
                    ...baselineCosts,
                    takerFeeRate: broken,
                }),
            ).toThrow(RangeError);
            expect(() =>
                estimatedRoundTripCost(20000, {
                    ...baselineCosts,
                    slippageRate: broken,
                }),
            ).toThrow(RangeError);
        }
    });

    it('answers calculation_error when the cost overflows', () => {
        const result = estimatedRoundTripCost(1e308, {
            takerFeeRate: 0.1,
            spreadRate: 0.5,
            slippageRate: 0.5,
            executionReserveRate: 0.5,
        });

        expect(result.quote.value).toBeNull();
        expect(result.quote.status).toBe('calculation_error');
        expect(result.quote.reasonCode).toBe('CALCULATION_OVERFLOW');
        expect(result.percent.value).toBeCloseTo(270, 12);
        expect(result.percent.status).toBe('valid');
    });
});

describe('the guard behind the schema', () => {
    it('throws on quantities that cannot exist', () => {
        expect(() =>
            absoluteNotionalQuote({ ...linearSpec, qtyBase: 0 }),
        ).toThrow(RangeError);
        expect(() =>
            absoluteNotionalQuote({ ...linearSpec, entryPrice: Number.NaN }),
        ).toThrow(RangeError);
        expect(() =>
            invalidationDistance({
                side: 'LONG',
                entryPrice: -1,
                levelQuote: 1,
            }),
        ).toThrow(RangeError);
    });
});

describe('integration into the report', () => {
    it('publishes the stage-2 metrics for the baseline linear position', () => {
        const report = buildRiskReport(linearPerpInput());
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('entryNotionalQuote')?.value).toBe(20000);
        expect(byKey.get('absoluteExposureBaseUnits')?.value).toBe(0.5);
        expect(byKey.get('directedExposureQuote')?.value).toBe(20000);
        expect(byKey.get('potentialPnlQuote')?.value).toBeCloseTo(-500, 9);
        expect(
            byKey.get('potentialPnlPercentOfEntryNotional')?.value,
        ).toBeCloseTo(-2.5, 9);
        expect(byKey.get('potentialPnlBaseUnits')).toBeUndefined();
        expect(byKey.get('estimatedRoundTripCostQuote')?.value).toBeCloseTo(84, 9);
        expect(
            byKey.get('estimatedRoundTripCostPercentOfEntryNotional')?.value,
        ).toBeCloseTo(0.42, 12);
        expect(byKey.get('invalidationDistanceQuote')?.status).toBe(
            'not_applicable',
        );
        expect(byKey.get('invalidationDistanceQuote')?.value).toBeNull();
        expect(report.modelVersions.positionMath).toBe('position-math@6');
        expect(report.conventions.inversePnlQuoteValuation).toBe(
            'market-snapshot-at-current-price',
        );
        expect(report.conventions.invalidationAtrPriceBasis).toBe(
            'entry-price-fraction',
        );
        expect(report.reportStatus).toBe('valid');
    });

    it('computes the invalidation distances when a level is provided', () => {
        const report = buildRiskReport(
            linearPerpInput({ invalidationLevelQuote: 38000 }),
        );
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('invalidationDistanceQuote')?.value).toBe(2000);
        expect(byKey.get('invalidationDistancePercent')?.value).toBeCloseTo(5, 12);
        expect(byKey.get('invalidationDistanceAtr')?.value).toBeCloseTo(2.5, 12);
    });

    it('drags the position section down when the level contradicts the side', () => {
        const report = buildRiskReport(
            linearPerpInput({ invalidationLevelQuote: 42000 }),
        );
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('invalidationDistanceQuote')?.status).toBe(
            'insufficient_data',
        );
        expect(report.positionRisk.status).toBe('insufficient_data');
        expect(report.reportStatus).toBe('insufficient_data');
        expect(
            report.warnings.some(
                (warning) =>
                    warning.code === 'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
            ),
        ).toBe(true);
    });

    it('keeps the potential PnL unanswered when no exit price is given', () => {
        const report = buildRiskReport(linearPerpInput({ exitPriceQuote: null }));
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('potentialPnlQuote')?.status).toBe('not_applicable');
        expect(byKey.get('potentialPnlQuote')?.value).toBeNull();
        expect(report.reportStatus).toBe('valid');
    });

    it('publishes the base-denominated PnL only for the inverse', () => {
        const rules = reviewedInverseRules({
            contractKind: 'inverse_perp',
            liquidationFormulaId: 'inverse_manual_v1',
        });
        const report = buildRiskReport(
            inversePerpInput({
                contractKind: 'inverse_perp',
                contractSizeUsd: 100,
                marginCurrency: 'base',
                notionalQuote: 50,
                margin: { mode: 'isolated', rules },
            }),
        );
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('entryNotionalQuote')?.value).toBe(50);
        expect(byKey.get('potentialPnlBaseUnits')?.status).toBe('valid');
        expect(byKey.get('potentialPnlBaseUnits')?.value).not.toBeNull();
        expect(byKey.get('potentialPnlQuote')?.value).not.toBeNull();
        // The percent is PnL over the confirmed USD notional: the unrealized
        // PnL is +1.25 on a 50 notional, the potential at exit 39000 is
        // -1.31410... on the same 50.
        expect(
            byKey.get('unrealizedPnlPercentOfEntryNotional')?.value,
        ).toBeCloseTo(2.5, 12);
        expect(
            byKey.get('potentialPnlPercentOfEntryNotional')?.value,
        ).toBeCloseTo(-2.6282051282051283, 12);
        // The cost basis is the same 50: 50 x 0.0042.
        expect(byKey.get('estimatedRoundTripCostQuote')?.value).toBeCloseTo(
            0.21,
            12,
        );
    });

    it('refuses the base figure for a quote-margined inverse', () => {
        const rules = reviewedInverseRules({
            contractKind: 'inverse_perp',
            liquidationFormulaId: 'inverse_manual_v1',
            contractSizeUsd: 100,
            marginCurrency: 'quote',
        });
        const report = buildRiskReport(
            inversePerpInput({
                contractKind: 'inverse_perp',
                contractSizeUsd: 100,
                marginCurrency: 'quote',
                notionalQuote: 50,
                margin: { mode: 'isolated', rules },
            }),
        );
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('potentialPnlBaseUnits')?.status).toBe(
            'not_applicable',
        );
        expect(byKey.get('potentialPnlBaseUnits')?.reasonCode).toBe(
            'INVERSE_SETTLEMENT_NOT_BASE',
        );
        expect(byKey.get('potentialPnlQuote')?.status).toBe('valid');
        expect(byKey.get('potentialPnlPercentOfEntryNotional')?.status).toBe(
            'valid',
        );
    });

    it('never ships an overflowed cost as valid', () => {
        const report = buildRiskReport(
            inversePerpInput({
                qtyBase: 1e303,
                contractSizeUsd: 1e5,
                marginCurrency: 'base',
                notionalQuote: 1e308,
                contractKind: 'inverse_perp',
                costs: {
                    takerFeeRate: 0.1,
                    makerFeeRate: 0.1,
                    spreadRate: 0.5,
                    slippageRate: 0.5,
                    executionReserveRate: 0.5,
                    fundingRatePerInterval: 0.0001,
                },
                margin: {
                    mode: 'isolated',
                    rules: reviewedInverseRules({
                        contractKind: 'inverse_perp',
                        liquidationFormulaId: 'inverse_manual_v1',
                    }),
                },
            }),
        );
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('entryNotionalQuote')?.value).toBe(1e308);
        expect(byKey.get('estimatedRoundTripCostQuote')?.value).toBeNull();
        expect(byKey.get('estimatedRoundTripCostQuote')?.status).toBe(
            'calculation_error',
        );
        expect(byKey.get('estimatedRoundTripCostQuote')?.reasonCode).toBe(
            'CALCULATION_OVERFLOW',
        );
        expect(
            byKey.get('estimatedRoundTripCostPercentOfEntryNotional')?.value,
        ).toBeCloseTo(270, 9);
    });

    it('answers the whole stage-2 block for a spot position', () => {
        const report = buildRiskReport(spotInput());
        const byKey = new Map(
            report.positionRisk.metrics.map((entry) => [entry.metricKey, entry]),
        );

        expect(byKey.get('entryNotionalQuote')?.value).toBe(20000);
        expect(byKey.get('absoluteExposureBaseUnits')?.value).toBe(0.5);
        expect(byKey.get('directedExposureQuote')?.value).toBe(20000);
        expect(byKey.get('potentialPnlQuote')?.value).toBeCloseTo(-500, 9);
        expect(byKey.get('estimatedRoundTripCostQuote')?.value).toBeCloseTo(84, 9);
        expect(report.reportStatus).toBe('valid');
    });
});
