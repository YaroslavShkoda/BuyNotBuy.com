import {
    type ContractKind,
    FUNDING_APPLICABILITY,
    type RiskNoticeCode,
    type RiskStatus,
} from '../types/risk.js';

/**
 * Whether funding applies to a contract kind, and what its absence means.
 *
 * The answer lives in `FUNDING_APPLICABILITY`, a `Record` over every contract
 * kind: a new kind cannot be added without deciding funding applicability in
 * the same edit, because the record stops compiling until it does. Nothing in
 * this module guesses about contracts outside that record.
 *
 * A funding rate is a signed fraction of notional per interval. Positive
 * rates cost a LONG and credit a SHORT; negative rates reverse the flow.
 * Linear quote cost uses currentPrice x base quantity. Inverse quote cost
 * uses contract count x USD face value, only with USD quote currency.
 * Availability alone does not confirm the inverse contract specification.
 */

export type FundingApplicability = 'applicable' | 'not_applicable';

export function fundingApplicability(kind: ContractKind): FundingApplicability {
    return FUNDING_APPLICABILITY[kind];
}

export interface FundingAvailability {
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
}

/**
 * What a funding-dependent metric may claim.
 *
 * Applicable with a reading: `valid`. Applicable and missing: `degraded` —
 * the position exists and its other risk is real, but this number is unknown
 * and never zero. Not applicable: `not_applicable`, which is an answer, not a
 * failure.
 */
export function fundingAvailability(
    kind: ContractKind,
    fundingRatePerInterval: number | null,
): FundingAvailability {
    if (fundingApplicability(kind) === 'not_applicable') {
        return { status: 'not_applicable', reasonCode: 'FUNDING_NOT_APPLICABLE' };
    }

    if (fundingRatePerInterval === null) {
        return { status: 'degraded', reasonCode: 'UNKNOWN_FUNDING' };
    }

    return { status: 'valid', reasonCode: null };
}
