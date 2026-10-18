import type {
    ContractKind,
    PositionSide,
    RiskNoticeCode,
    RiskStatus,
} from '../types/risk.js';
import { exactAdd, exactDivide, exactMultiply, exactNumber, roundExact } from './exact-rational.js';
import { finiteProduct } from './finite-product.js';
import { inversePnlExact } from './inverse-pnl.js';
import { linearPnlExact } from './linear-pnl.js';

/**
 * Stage-2 position mathematics, under the stage-1 report contract.
 *
 * Pure functions, one question each: exposure and notional, potential PnL at a
 * named exit price, distance to the invalidation level, and the
 * execution-cost estimate the input's own rates justify. Nothing here reads
 * state, fetches, or writes; a question the input cannot answer comes back as
 * a status with a reason from the closed set — never as a zero.
 *
 * Formulas, stated where they live:
 *  - spot and linear perp: quote PnL is `±(exit − entry) × qty`, with `qty`
 *    in base units; the position notional is `qty × entry`.
 *  - inverse perp: `qty` counts contracts and `contractSizeUsd` is the
 *    confirmed USD face value of one contract, so the position
 *    notional is `qty × contractSizeUsd`; base PnL is
 *    `±size × qty × (1/entry − 1/exit)`, and the quote figure re-values that
 *    base PnL at the current price — a market-snapshot valuation, never a
 *    silent conversion. Without the confirmed specification the inverse
 *    answers `insufficient_data`; the linear formula is never borrowed for
 *    it. A base-denominated PnL is a settlement figure only when the
 *    contract's `marginCurrency` is the base. Inverse prices and quote amounts
 *    here are USD: RiskInputSchema enforces USD quote currency at the report
 *    boundary. These pure functions perform no FX conversion.
 *
 * PnL arithmetic uses exact binary64 inputs and rounds each metric once,
 * independently, nearest/ties-to-even. Its percent denominator remains the
 * published entry notional, rather than a cancelled exact notional.
 * The arithmetic never ships a broken number: every result passes through a
 * finiteness gate, and an overflowed or non-finite figure answers
 * `calculation_error` with `CALCULATION_OVERFLOW` instead of a `valid`
 * Infinity. Negative zero is normalized away where it carries no meaning.
 */

/** One computed answer: a number with its trust level, or the reason there is none. */
export interface MathValue {
    readonly value: number | null;
    readonly status: RiskStatus;
    readonly reasonCode: RiskNoticeCode | null;
}

/** The input facts exposure and PnL are computed from. */
export interface PositionSpec {
    readonly contractKind: ContractKind;
    readonly side: PositionSide;
    /** Base units for spot/linear, contract count for inverse. */
    readonly qtyBase: number;
    readonly entryPrice: number;
    /** USD per inverse contract; `null` until the specification is confirmed. */
    readonly contractSizeUsd: number | null;
    /**
     * Inverse contracts only: the currency the contract settles in. A
     * base-denominated PnL is a settlement figure only for `'base'`.
     */
    readonly marginCurrency: 'base' | 'quote' | null;
}

const sideSign = (side: PositionSide): 1 | -1 => (side === 'LONG' ? 1 : -1);

/**
 * Schema-validated quantities, re-checked at the boundary.
 *
 * The input schema is the front door, and these guards are the second lock: a
 * direct caller that bypasses the parser meets a thrown `RangeError` instead
 * of a silently wrong number.
 */
function assertPositive(name: string, value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(
            `${name} must be a finite positive number, got ${String(value)}`,
        );
    }
}

function assertFinite(name: string, value: number): void {
    if (!Number.isFinite(value)) {
        throw new RangeError(
            `${name} must be a finite number, got ${String(value)}`,
        );
    }
}

function insufficient(reason: RiskNoticeCode): MathValue {
    return { value: null, status: 'insufficient_data', reasonCode: reason };
}

function notApplicable(reason: RiskNoticeCode): MathValue {
    return { value: null, status: 'not_applicable', reasonCode: reason };
}

/**
 * The only gate a computed number passes on its way into the report.
 *
 * A finite result is `valid`, with negative zero folded onto zero; anything
 * else — Infinity, -Infinity, NaN — is `calculation_error` naming the
 * overflow, because a broken number must never look like an answer.
 */
function finiteOrOverflow(value: number): MathValue {
    if (!Number.isFinite(value)) {
        return { value: null, status: 'calculation_error', reasonCode: 'CALCULATION_OVERFLOW' };
    }

    return { value: value === 0 ? 0 : value, status: 'valid', reasonCode: null };
}

/**
 * Absolute notional at entry, in quote currency.
 *
 * All figures are exact products rounded once, nearest/ties-to-
 * even. A nonzero product that underflows to zero — or overflows — answers
 * `calculation_error`, never a `valid` zero.
 */
export function absoluteNotionalQuote(spec: PositionSpec): MathValue {
    assertPositive('qtyBase', spec.qtyBase);
    assertPositive('entryPrice', spec.entryPrice);

    if (spec.contractKind === 'inverse_perp') {
        if (spec.contractSizeUsd === null) {
            return insufficient('MISSING_INVERSE_CONTRACT_PARAMS');
        }

        assertPositive('contractSizeUsd', spec.contractSizeUsd);

        return finiteProduct(spec.contractSizeUsd, spec.qtyBase, 1);
    }

    return finiteProduct(spec.qtyBase, spec.entryPrice, 1);
}

/**
 * The position's size in base units; the inverse needs the confirmed size.
 *
 * Inverse exposure divides the exact product by the exact entry price and
 * rounds once — never out of the already rounded notional, which would
 * double-round and could lose the difference between zero and subnormal.
 * A nonzero value that rounds to zero, or an overflow, answers
 * `calculation_error`.
 */
export function absoluteExposureBaseUnits(spec: PositionSpec): MathValue {
    assertPositive('qtyBase', spec.qtyBase);
    assertPositive('entryPrice', spec.entryPrice);

    if (spec.contractKind === 'inverse_perp') {
        if (spec.contractSizeUsd === null) {
            return insufficient('MISSING_INVERSE_CONTRACT_PARAMS');
        }

        assertPositive('contractSizeUsd', spec.contractSizeUsd);

        return roundExact(exactDivide(
            exactMultiply(exactNumber(spec.contractSizeUsd), exactNumber(spec.qtyBase)),
            exactNumber(spec.entryPrice),
        ));
    }

    return finiteOrOverflow(spec.qtyBase);
}

/** Absolute notional signed by the side: positive long, negative short. */
export function directedExposureQuote(spec: PositionSpec): MathValue {
    const absolute = absoluteNotionalQuote(spec);

    if (absolute.value === null) {
        return absolute;
    }

    return finiteOrOverflow(sideSign(spec.side) * absolute.value);
}

export interface PotentialPnlArgs extends PositionSpec {
    readonly currentPrice: number;
    /** The what-if exit; `null` means the question was not asked. */
    readonly exitPrice: number | null;
}

export interface PotentialPnl {
    /** In quote currency. */
    readonly quote: MathValue;
    /**
     * Percent of the position notional `entryNotionalQuote` — the same
     * kind-aware figure the notional metric publishes, never a separately
     * derived denominator. This is percent of notional, not return on margin
     * or capital.
     */
    readonly percent: MathValue;
    /**
     * In base units, computed for the inverse contract only, and only when
     * the contract settles in the base currency: for a quote-margined
     * inverse a base figure is not the settlement value, so it answers
     * `not_applicable` rather than masquerading as one. `null` for spot and
     * linear, whose native PnL currency is the quote.
     */
    readonly base: MathValue | null;
}

export function potentialPnl(args: PotentialPnlArgs): PotentialPnl {
    assertPositive('qtyBase', args.qtyBase);
    assertPositive('entryPrice', args.entryPrice);
    assertPositive('currentPrice', args.currentPrice);

    if (args.exitPrice === null) {
        const unanswered = notApplicable('EXIT_PRICE_NOT_PROVIDED');

        return { quote: unanswered, percent: unanswered, base: unanswered };
    }

    assertPositive('exitPrice', args.exitPrice);

    // The percent denominator is the published notional, from the same
    // function the notional metric uses — one definition, never a copy.
    const notional = absoluteNotionalQuote(args);

    if (args.contractKind === 'inverse_perp') {
        if (args.contractSizeUsd === null || args.marginCurrency === null) {
            const unanswered = insufficient('MISSING_INVERSE_CONTRACT_PARAMS');

            return {
                quote: unanswered,
                percent: unanswered,
                base: unanswered,
            };
        }

        assertPositive('contractSizeUsd', args.contractSizeUsd);

        const exact = inversePnlExact({ ...args, contractSizeUsd: args.contractSizeUsd, exitPrice: args.exitPrice });
        // Each metric rounds independently. In particular, neither a rounded
        // base nor a rounded quote is an input to another metric.
        const quote = roundExact(exact.quote);
        const percent =
            notional.value === null
                ? notional
                : notional.value === 0
                ? { value: null, status: 'calculation_error' as const, reasonCode: 'CALCULATION_OVERFLOW' as const }
                : roundExact(exactDivide(
                    exactMultiply(exact.quote, exactNumber(100)),
                    exactNumber(notional.value),
                ));

        return {
            quote,
            percent,
            base:
                args.marginCurrency === 'base'
                    ? roundExact(exact.base)
                    : notApplicable('INVERSE_SETTLEMENT_NOT_BASE'),
        };
    }

    const exactQuote = linearPnlExact({ ...args, exitPrice: args.exitPrice });
    const quote = roundExact(exactQuote);
    // A failed quote rounding must not hide a representable percent. Keep
    // the established denominator: the published, rounded entry notional.
    const percent =
        notional.value === null
            ? notional
            : roundExact(exactDivide(
                exactMultiply(exactQuote, exactNumber(100)),
                exactNumber(notional.value),
            ));

    return { quote, percent, base: null };
}

export interface InvalidationArgs {
    readonly side: PositionSide;
    readonly entryPrice: number;
    /** `null` means no level was provided. */
    readonly levelQuote: number | null;
}

export interface InvalidationDistances {
    /** Absolute distance from entry to the level, in quote currency. */
    readonly absolute: MathValue;
    /** The same distance as percent of the entry price. */
    readonly percent: MathValue;
}

/**
 * Distance from entry to the invalidation level, measured toward the side
 * that hurts the position: down for a long, up for a short.
 *
 * A level on the favorable side contradicts the position — a long cannot be
 * invalidated by rising. That is bad data about the level, not a negative
 * distance: the metrics answer `insufficient_data` instead of shipping a
 * number their direction makes meaningless. A level exactly at entry is the
 * degenerate but honest zero.
 */
export function invalidationDistance(
    args: InvalidationArgs,
): InvalidationDistances {
    assertPositive('entryPrice', args.entryPrice);

    if (args.levelQuote === null) {
        const unanswered = notApplicable('INVALIDATION_LEVEL_NOT_PROVIDED');

        return { absolute: unanswered, percent: unanswered };
    }

    assertPositive('levelQuote', args.levelQuote);

    const adverse = args.side === 'LONG'
        ? args.entryPrice - args.levelQuote
        : args.levelQuote - args.entryPrice;

    if (adverse < 0) {
        const contradicted = insufficient(
            'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
        );

        return { absolute: contradicted, percent: contradicted };
    }

    const absolute = Math.abs(args.levelQuote - args.entryPrice);

    return {
        absolute: finiteOrOverflow(absolute),
        percent: finiteOrOverflow((absolute / args.entryPrice) * 100),
    };
}

/**
 * The invalidation distance in ATR units.
 *
 * ATR travels as a fraction of price — the `AtrRef` contract — and this
 * distance is normalized by that fraction of the entry price
 * (`conventions.invalidationAtrPriceBasis`). The level questions come first:
 * a missing or contradicted level answers its own reason before ATR is
 * consulted. A dead ATR — zero, negative, or not finite — is
 * `insufficient_data`, never a zero distance. If the normalization product
 * overflows, divide by entry and ATR separately rather than publishing zero.
 */
export function invalidationAtrDistance(
    args: InvalidationArgs & { readonly atrValue: number },
): MathValue {
    const distances = invalidationDistance(args);

    if (distances.absolute.value === null) {
        return distances.absolute;
    }

    const { atrValue } = args;

    if (!Number.isFinite(atrValue) || atrValue <= 0) {
        return insufficient('ATR_UNUSABLE');
    }

    const normalization = atrValue * args.entryPrice;

    return finiteOrOverflow(Number.isFinite(normalization)
        ? distances.absolute.value / normalization
        : (distances.absolute.value / args.entryPrice) / atrValue);
}

export interface CostRates {
    readonly takerFeeRate: number;
    readonly spreadRate: number;
    readonly slippageRate: number;
    readonly executionReserveRate: number;
}

export interface EstimatedCost {
    /** Round-trip estimate in quote currency, on the position notional. */
    readonly quote: MathValue;
    /** The same estimate as percent of the position notional. */
    readonly percent: MathValue;
}

/**
 * Round-trip execution-cost estimate from the rates the input provides.
 *
 * `spreadRate` is the full relative spread: one leg crosses half of it, so a
 * round trip pays the whole spread once. One leg is
 * `taker + half spread + slippage + execution reserve`, all as fractions of
 * notional; the round trip is two such legs on the position notional, because
 * the exit notional is unknown until an exit price is chosen — estimating the
 * exit leg at the entry notional keeps every position's cost figure
 * comparable, and the limitation is stated in the report assumptions. Every
 * rate is a provided reading: nothing here invents a venue fee and nothing
 * unknown is treated as zero. Funding is excluded entirely — it is a holding
 * cost needing a holding period the input does not carry, and it already has
 * its own metric.
 */
export function estimatedRoundTripCost(
    entryNotionalQuote: number,
    rates: CostRates,
): EstimatedCost {
    assertPositive('entryNotionalQuote', entryNotionalQuote);
    assertFinite('takerFeeRate', rates.takerFeeRate);
    assertFinite('spreadRate', rates.spreadRate);
    assertFinite('slippageRate', rates.slippageRate);
    assertFinite('executionReserveRate', rates.executionReserveRate);

    // Algebraically the same two legs, without first halving a subnormal
    // spread or rounding a small rate/product to a false zero. Quote and
    // percent round independently; a failure of one does not erase the other.
    const roundTripRate = exactAdd(
        exactMultiply(exactNumber(2), exactAdd(
            exactAdd(exactNumber(rates.takerFeeRate), exactNumber(rates.slippageRate)),
            exactNumber(rates.executionReserveRate),
        )),
        exactNumber(rates.spreadRate),
    );

    return {
        quote: roundExact(exactMultiply(exactNumber(entryNotionalQuote), roundTripRate)),
        percent: roundExact(exactMultiply(roundTripRate, exactNumber(100))),
    };
}
