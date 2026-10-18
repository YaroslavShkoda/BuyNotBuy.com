import type {
    MarginRules,
    PositionSide,
    RiskNoticeCode,
    RiskStatus,
} from '../types/risk.js';
import { exactAdd, exactDivide, exactMultiply, exactNumber, exactSubtract, roundExact } from './exact-rational.js';
import { marginRulesReadiness } from './margin-rules.js';

/**
 * Liquidation estimates, and the honest answers when there is no estimate.
 *
 * Two different questions live here and must never merge. Whether margin
 * requirements are breached *now* is an arithmetic check over equity and the
 * maintenance requirement. What a liquidation would cost is an estimate built
 * on a formula — and a formula this file does not have for a contract kind is
 * a formula the report refuses to fake.
 *
 * The one implemented formula is the linear-algebra consequence of the
 * isolated-margin definition for a quote-margined (linear) contract:
 *
 *     long:  P_liq = (entry*qty - collateral) / (qty * (1 - mmr))
 *     short: P_liq = (entry*qty + collateral) / (qty * (1 + mmr))
 *
 * It is arithmetic, not a venue rule, and it ignores fees, funding and the
 * execution reserve — each omission is a stated assumption of the report, not
 * a hidden simplification. Venue-specific liquidation logic (tiered MMR,
 * bonus margins, inverse contracts) is deliberately absent: this stage has no
 * confirmed rule for it, so those inputs get `insufficient_data` with a
 * reason instead of a number dressed up as one.
 */

export interface LiquidationEstimate {
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
    readonly liquidationPriceQuote: number | null;
    /**
     * Gross quote loss between entry and the estimated liquidation price.
     * Positive means money lost. Fees are not subtracted; that is stated in
     * the report's assumptions and limitations, not hidden in the sign.
     */
    readonly projectedLossQuote: number | null;
}

const estimate = (
    status: RiskStatus,
    reasonCode: RiskNoticeCode | null,
    liquidationPriceQuote: number | null,
    projectedLossQuote: number | null,
): LiquidationEstimate => {
    if (
        (liquidationPriceQuote !== null && !Number.isFinite(liquidationPriceQuote)) ||
        (projectedLossQuote !== null && !Number.isFinite(projectedLossQuote))
    ) {
        return {
            status: 'calculation_error',
            reasonCode: 'CALCULATION_OVERFLOW',
            liquidationPriceQuote: null,
            projectedLossQuote: null,
        };
    }

    return { status, reasonCode, liquidationPriceQuote, projectedLossQuote };
};

export function linearIsolatedLiquidationPrice(args: {
    side: PositionSide;
    qtyBase: number;
    entryPrice: number;
    collateralQuote: number;
    maintenanceMarginRate: number;
}): LiquidationEstimate {
    const { side, qtyBase, entryPrice, collateralQuote, maintenanceMarginRate } = args;
    if (![qtyBase, entryPrice, collateralQuote, maintenanceMarginRate].every(Number.isFinite)) {
        return estimate('calculation_error', 'CALCULATION_OVERFLOW', null, null);
    }
    if (qtyBase <= 0 || entryPrice <= 0 || collateralQuote <= 0 ||
        maintenanceMarginRate < 0 || maintenanceMarginRate >= 1) {
        return estimate('insufficient_data', 'IMPOSSIBLE_LIQUIDATION_GEOMETRY', null, null);
    }

    // The existing isolated formula, evaluated over exact binary64 inputs.
    // In particular, compare collateral with the EXACT product: even a
    // representable subnormal notional may round down to collateral and
    // incorrectly make a reachable LONG liquidation disappear.
    const qty = exactNumber(qtyBase);
    const entry = exactNumber(entryPrice);
    const collateral = exactNumber(collateralQuote);
    const notional = exactMultiply(entry, qty);
    const numerator = side === 'LONG'
        ? exactSubtract(notional, collateral)
        : exactAdd(notional, collateral);
    if (side === 'LONG' && numerator.numerator <= 0n) {
        return estimate('not_applicable', 'LIQUIDATION_NOT_REACHABLE', null, null);
    }
    const factor = side === 'LONG'
        ? exactSubtract(exactNumber(1), exactNumber(maintenanceMarginRate))
        : exactAdd(exactNumber(1), exactNumber(maintenanceMarginRate));
    const exactPrice = exactDivide(numerator, exactMultiply(qty, factor));
    const price = roundExact(exactPrice);
    const gap = side === 'LONG'
        ? exactSubtract(entry, exactPrice)
        : exactSubtract(exactPrice, entry);
    // Preserve the existing nonnegative gross-loss convention. Round from
    // the exact price, so its publication rounding cannot erase a small loss.
    const loss = gap.numerator <= 0n
        ? { value: 0, status: 'valid' as const }
        : roundExact(exactMultiply(gap, qty));
    if (price.status !== 'valid' || loss.status !== 'valid') {
        return estimate('calculation_error', 'CALCULATION_OVERFLOW', null, null);
    }
    return estimate('valid', null, price.value, loss.value);
}

/**
 * Percent of current price separating it from the estimated liquidation price,
 * signed by the position's liquidation side.
 *
 * Positive: the price still has that far to travel before the estimate fires.
 * Negative: the estimated liquidation price is already behind the market — a
 * state the marginViolation section is responsible for naming, not this one.
 */
export function percentDistanceToLiquidation(
    side: PositionSide,
    currentPrice: number,
    liquidationPriceQuote: number,
): number {
    const raw =
        side === 'LONG'
            ? ((currentPrice - liquidationPriceQuote) / currentPrice) * 100
            : ((liquidationPriceQuote - currentPrice) / currentPrice) * 100;

    return raw;
}

/**
 * The same distance in ATR units.
 *
 * The ATR is a fraction of price, so distance-in-ATR is the price gap divided
 * by `atr * currentPrice`. A zero or negative ATR cannot produce a number —
 * returning null here is what keeps a dead ATR from reading as "liquidation
 * is infinitely close", which is what a division by zero would publish.
 */
export function atrDistanceToLiquidation(
    currentPrice: number,
    liquidationPriceQuote: number,
    atrValue: number,
): number | null {
    if (!(atrValue > 0)) {
        return null;
    }

    const gap = Math.abs(currentPrice - liquidationPriceQuote);
    const normalization = atrValue * currentPrice;

    // A huge ATR normalization must not turn a nonzero distance into a false
    // zero merely because the denominator overflowed.
    return Number.isFinite(normalization)
        ? gap / normalization
        : (gap / currentPrice) / atrValue;
}

/** Everything the report needs to decide how — or whether — to estimate. */
export interface LiquidationDispatch {
    readonly contractKind: 'spot' | 'linear_perp' | 'inverse_perp';
    readonly marginMode: 'isolated' | 'cross' | null;
    readonly rules: MarginRules | null;
    readonly quoteCurrency: string;
    readonly side: PositionSide;
    readonly qtyBase: number;
    readonly entryPrice: number;
    readonly collateralQuote: number | null;
}

export function assessLiquidation(input: LiquidationDispatch): LiquidationEstimate {
    if (input.contractKind === 'spot') {
        return estimate('not_applicable', 'MARGIN_NOT_APPLICABLE', null, null);
    }

    if (input.rules === null) {
        return estimate('insufficient_data', 'MARGIN_RULES_MISSING', null, null);
    }

    if (input.marginMode === 'cross') {
        return estimate('insufficient_data', 'CROSS_MARGIN_NOT_ASSESSABLE', null, null);
    }

    if (input.contractKind === 'inverse_perp') {
        return input.rules.contractSizeUsd === null || input.rules.marginCurrency === null
            ? estimate('insufficient_data', 'MISSING_INVERSE_CONTRACT_PARAMS', null, null)
            : estimate('insufficient_data', 'LIQUIDATION_FORMULA_UNCONFIRMED', null, null);
    }

    const readiness = marginRulesReadiness(input.rules, input.quoteCurrency);

    if (readiness.status === 'incomplete') {
        return estimate('insufficient_data', readiness.reasonCode, null, null);
    }

    if (input.collateralQuote === null) {
        // Unreachable through the validated input (a perp requires collateral),
        // kept as a guard so the formula below never sees a null.
        return estimate('insufficient_data', 'IMPOSSIBLE_LIQUIDATION_GEOMETRY', null, null);
    }

    const computed = linearIsolatedLiquidationPrice({
        side: input.side,
        qtyBase: input.qtyBase,
        entryPrice: input.entryPrice,
        collateralQuote: input.collateralQuote,
        maintenanceMarginRate: input.rules.maintenanceMarginRate,
    });

    if (readiness.status === 'draft' && computed.status === 'valid') {
        return estimate(
            'degraded',
            'MARGIN_RULES_DRAFT',
            computed.liquidationPriceQuote,
            computed.projectedLossQuote,
        );
    }

    return computed;
}
