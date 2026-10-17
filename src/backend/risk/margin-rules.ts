import {
    LINEAR_ISOLATED_FORMULA_ID,
    type MarginRules,
    type RiskNoticeCode,
} from '../types/risk.js';

/**
 * Whether a hand-supplied margin config is complete enough to compute with.
 *
 * Syntax was already checked by the schema. This is the second question, and
 * it is a different one: a config can parse cleanly and still be unable to
 * support a liquidation estimate, because the parameters its contract kind
 * needs are absent, or the formula it names is not one this stage implements.
 * An incomplete config is accepted input whose liquidation metrics come out
 * `insufficient_data` — refusing it outright would also silence the market
 * metrics that never needed the rules.
 *
 * Nothing here asserts venue truth. "Reviewed" means a person signed the
 * config, not that an exchange confirmed it.
 */

export interface MarginRulesReadiness {
    readonly status: 'ok' | 'draft' | 'incomplete';
    readonly reasonCode: RiskNoticeCode | null;
    readonly detail: string;
}

export function marginRulesReadiness(
    rules: MarginRules,
    quoteCurrency: string,
): MarginRulesReadiness {
    const incomplete = (reasonCode: RiskNoticeCode, detail: string): MarginRulesReadiness => ({
        status: 'incomplete',
        reasonCode,
        detail,
    });

    if (rules.collateralCurrency !== quoteCurrency) {
        return incomplete(
            'MARGIN_RULES_MISMATCH',
            `rules collateral currency ${rules.collateralCurrency} does not match the position quote ${quoteCurrency}`,
        );
    }

    if (
        rules.maintenanceMarginRate <= 0 ||
        rules.maintenanceMarginRate >= 1 ||
        rules.initialMarginRate <= 0 ||
        rules.initialMarginRate >= 1
    ) {
        return incomplete(
            'IMPOSSIBLE_LIQUIDATION_GEOMETRY',
            'margin rates must lie strictly inside (0, 1)',
        );
    }

    if (rules.contractKind === 'linear_perp') {
        if (rules.liquidationFormulaId !== LINEAR_ISOLATED_FORMULA_ID) {
            return incomplete(
                'LIQUIDATION_FORMULA_UNCONFIRMED',
                `linear_perp rules name formula "${rules.liquidationFormulaId}", but this stage implements only ${LINEAR_ISOLATED_FORMULA_ID}`,
            );
        }
    }

    if (rules.contractKind === 'inverse_perp') {
        if (rules.contractSizeUsd === null || rules.marginCurrency === null) {
            return incomplete(
                'MISSING_INVERSE_CONTRACT_PARAMS',
                'inverse_perp rules require contractSizeUsd and marginCurrency',
            );
        }

        // Stage 1 implements no inverse liquidation formula: the venue's
        // inverse-margin arithmetic is not a confirmed rule here, and a
        // borrowed linear formula would be a confident wrong number.
        return incomplete(
            'LIQUIDATION_FORMULA_UNCONFIRMED',
            'no inverse liquidation formula is implemented or confirmed at this stage',
        );
    }

    if (rules.reviewStatus === 'draft') {
        return {
            status: 'draft',
            reasonCode: 'MARGIN_RULES_DRAFT',
            detail: 'margin rules have not been reviewed; a liquidation estimate from them cannot be called valid',
        };
    }

    return { status: 'ok', reasonCode: null, detail: 'rules complete and reviewed' };
}
