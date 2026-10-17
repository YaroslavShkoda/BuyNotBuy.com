import { describe, expect, it } from 'vitest';
import { reviewedLinearRules } from './fixtures.js';
import {
    assessLiquidation,
    atrDistanceToLiquidation,
    linearIsolatedLiquidationPrice,
    percentDistanceToLiquidation,
} from './liquidation-contract.js';

/**
 * Every number below was computed by hand from the formula under test, not
 * read back from the implementation:
 *
 *   long,  qty 0.5, entry 40000, collateral 4000, mmr 0.01:
 *     P_liq = (40000*0.5 - 4000) / (0.5 * 0.99) = 16000 / 0.495 = 32323.2323...
 *     loss  = (40000 - 32323.23...) * 0.5       = 3838.3838...
 *   short, same parameters:
 *     P_liq = (40000*0.5 + 4000) / (0.5 * 1.01) = 24000 / 0.505 = 47524.7525...
 *     loss  = (47524.75... - 40000) * 0.5       = 3762.3762...
 */

describe('linearIsolatedLiquidationPrice', () => {
    const base = {
        qtyBase: 0.5,
        entryPrice: 40000,
        collateralQuote: 4000,
        maintenanceMarginRate: 0.01,
    };

    it('computes the hand-checked long price', () => {
        const result = linearIsolatedLiquidationPrice({ ...base, side: 'LONG' });

        expect(result.status).toBe('valid');
        expect(result.liquidationPriceQuote).toBeCloseTo(32323.232323232323, 6);
        expect(result.projectedLossQuote).toBeCloseTo(3838.383838383838, 6);
    });

    it('computes the hand-checked short price', () => {
        const result = linearIsolatedLiquidationPrice({ ...base, side: 'SHORT' });

        expect(result.status).toBe('valid');
        expect(result.liquidationPriceQuote).toBeCloseTo(47524.75247524752, 6);
        expect(result.projectedLossQuote).toBeCloseTo(3762.3762376237623, 6);
    });

    it('reports "does not apply" for an unleveraged long instead of a phantom price', () => {
        const result = linearIsolatedLiquidationPrice({
            ...base,
            side: 'LONG',
            collateralQuote: 25000,
        });

        expect(result.status).toBe('not_applicable');
        expect(result.reasonCode).toBe('LIQUIDATION_NOT_REACHABLE');
        expect(result.liquidationPriceQuote).toBeNull();
    });

    it('refuses a maintenance rate that makes the formula meaningless', () => {
        const result = linearIsolatedLiquidationPrice({
            ...base,
            side: 'LONG',
            maintenanceMarginRate: 1,
        });

        expect(result.status).toBe('insufficient_data');
        expect(result.reasonCode).toBe('IMPOSSIBLE_LIQUIDATION_GEOMETRY');
        expect(result.liquidationPriceQuote).toBeNull();
    });
});

describe('distances', () => {
    const longLiq = 32323.232323232323;
    const shortLiq = 47524.75247524752;

    it('measures percent distance toward the liquidation side', () => {
        const longDistance = percentDistanceToLiquidation('LONG', 41000, longLiq);
        const shortDistance = percentDistanceToLiquidation('SHORT', 41000, shortLiq);

        expect(longDistance).toBeCloseTo(((41000 - longLiq) / 41000) * 100, 9);
        expect(shortDistance).toBeCloseTo(((shortLiq - 41000) / 41000) * 100, 9);
    });

    it('goes negative once the estimated price is behind the market', () => {
        expect(percentDistanceToLiquidation('LONG', 30000, longLiq)).toBeLessThan(0);
    });

    it('measures the same gap in ATR units against the given ATR fraction', () => {
        const units = atrDistanceToLiquidation(41000, longLiq, 0.02);

        expect(units).toBeCloseTo(Math.abs(41000 - longLiq) / (0.02 * 41000), 9);
    });

    it('returns null for a zero ATR rather than a zero or infinite distance', () => {
        expect(atrDistanceToLiquidation(41000, longLiq, 0)).toBeNull();
        expect(atrDistanceToLiquidation(41000, longLiq, -0.01)).toBeNull();
    });
});

describe('assessLiquidation dispatch', () => {
    const position = {
        contractKind: 'linear_perp',
        marginMode: 'isolated',
        quoteCurrency: 'USDT',
        side: 'LONG',
        qtyBase: 0.5,
        entryPrice: 40000,
        collateralQuote: 4000,
    } as const;

    it('sends spot to not_applicable', () => {
        const result = assessLiquidation({
            ...position,
            contractKind: 'spot',
            marginMode: null,
            rules: null,
        });

        expect(result.status).toBe('not_applicable');
        expect(result.reasonCode).toBe('MARGIN_NOT_APPLICABLE');
    });

    it('refuses to compute without rules', () => {
        const result = assessLiquidation({ ...position, rules: null });

        expect(result.status).toBe('insufficient_data');
        expect(result.reasonCode).toBe('MARGIN_RULES_MISSING');
    });

    it('refuses cross margin: one position is not a portfolio', () => {
        const result = assessLiquidation({
            ...position,
            marginMode: 'cross',
            rules: reviewedLinearRules({ mode: 'cross' }),
        });

        expect(result.status).toBe('insufficient_data');
        expect(result.reasonCode).toBe('CROSS_MARGIN_NOT_ASSESSABLE');
    });

    it('gives an inverse estimate insufficient_data with the precise reason', () => {
        const withoutParams = assessLiquidation({
            ...position,
            contractKind: 'inverse_perp',
            rules: reviewedLinearRules({ contractKind: 'inverse_perp' }),
        });

        expect(withoutParams.status).toBe('insufficient_data');
        expect(withoutParams.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');

        const withParams = assessLiquidation({
            ...position,
            contractKind: 'inverse_perp',
            rules: reviewedLinearRules({
                contractKind: 'inverse_perp',
                liquidationFormulaId: 'inverse_manual_v1',
                contractSizeUsd: 100,
                marginCurrency: 'base',
            }),
        });

        expect(withParams.status).toBe('insufficient_data');
        expect(withParams.reasonCode).toBe('LIQUIDATION_FORMULA_UNCONFIRMED');
        expect(withParams.liquidationPriceQuote).toBeNull();
    });

    it('computes for reviewed linear rules', () => {
        const result = assessLiquidation({ ...position, rules: reviewedLinearRules() });

        expect(result.status).toBe('valid');
        expect(result.liquidationPriceQuote).toBeCloseTo(32323.232323232323, 6);
    });

    it('never calls a draft-config estimate valid', () => {
        const result = assessLiquidation({
            ...position,
            rules: reviewedLinearRules({ reviewStatus: 'draft' }),
        });

        expect(result.status).toBe('degraded');
        expect(result.reasonCode).toBe('MARGIN_RULES_DRAFT');
        expect(result.liquidationPriceQuote).not.toBeNull();
    });
});
