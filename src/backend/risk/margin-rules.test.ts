import { describe, expect, it } from 'vitest';
import { reviewedLinearRules } from './fixtures.js';
import { marginRulesReadiness } from './margin-rules.js';

/**
 * Completeness is judged per contract kind, separately from syntax. A config
 * that parses but cannot support an estimate is `incomplete` — accepted input
 * whose liquidation metrics will be `insufficient_data`, not a refusal.
 */

describe('marginRulesReadiness', () => {
    it('accepts complete, reviewed linear rules', () => {
        const readiness = marginRulesReadiness(reviewedLinearRules(), 'USDT');

        expect(readiness.status).toBe('ok');
        expect(readiness.reasonCode).toBeNull();
    });

    it('refuses rules whose collateral currency disagrees with the position quote', () => {
        const readiness = marginRulesReadiness(
            reviewedLinearRules({ collateralCurrency: 'USDC' }),
            'USDT',
        );

        expect(readiness.status).toBe('incomplete');
        expect(readiness.reasonCode).toBe('MARGIN_RULES_MISMATCH');
    });

    it('refuses rates outside (0, 1)', () => {
        const readiness = marginRulesReadiness(
            reviewedLinearRules({ maintenanceMarginRate: 1 }),
            'USDT',
        );

        expect(readiness.status).toBe('incomplete');
        expect(readiness.reasonCode).toBe('IMPOSSIBLE_LIQUIDATION_GEOMETRY');
    });

    it('refuses linear rules naming a formula this stage does not implement', () => {
        const readiness = marginRulesReadiness(
            reviewedLinearRules({ liquidationFormulaId: 'venue_secret_sauce_v9' }),
            'USDT',
        );

        expect(readiness.status).toBe('incomplete');
        expect(readiness.reasonCode).toBe('LIQUIDATION_FORMULA_UNCONFIRMED');
    });

    it('marks draft rules as draft, not as unusable', () => {
        const readiness = marginRulesReadiness(
            reviewedLinearRules({ reviewStatus: 'draft' }),
            'USDT',
        );

        expect(readiness.status).toBe('draft');
        expect(readiness.reasonCode).toBe('MARGIN_RULES_DRAFT');
    });

    it('requires inverse contract parameters', () => {
        const readiness = marginRulesReadiness(
            reviewedLinearRules({
                contractKind: 'inverse_perp',
                liquidationFormulaId: 'inverse_manual_v1',
            }),
            'USDT',
        );

        expect(readiness.status).toBe('incomplete');
        expect(readiness.reasonCode).toBe('MISSING_INVERSE_CONTRACT_PARAMS');
    });

    it('still refuses a parameter-complete inverse config: no confirmed formula exists', () => {
        const readiness = marginRulesReadiness(
            reviewedLinearRules({
                contractKind: 'inverse_perp',
                liquidationFormulaId: 'inverse_manual_v1',
                contractSizeUsd: 100,
                marginCurrency: 'base',
            }),
            'USDT',
        );

        expect(readiness.status).toBe('incomplete');
        expect(readiness.reasonCode).toBe('LIQUIDATION_FORMULA_UNCONFIRMED');
    });
});
