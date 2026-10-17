import { z } from 'zod';

import { resolveInstrument } from '../config/asset.registry.js';
import {
    CANDLE_INTERVAL_MS,
    SUPPORTED_CANDLE_INTERVALS,
} from '../types/candle-interval.js';
import {
    CONTRACT_KINDS,
    LINEAR_ISOLATED_FORMULA_ID,
    MARGIN_MODES,
    POSITION_SIDES,
    POSITION_SOURCES,
} from '../types/risk.js';
import { MARKET_VENUES } from '../types/venue.js';
import { finiteProduct } from './finite-product.js';

/**
 * The shadow risk model's input contract.
 *
 * The input type is derived from these schemas rather than declared beside
 * them: a hand-written interface and a validator are two copies of one
 * contract, and the copy that drifts is the one nobody parsed. The report
 * shapes stay hand-written in `types/risk.ts`, because the builder constructs
 * them and the compiler must check that construction.
 *
 * Validation is deliberately two-layered. What lives here is syntax and
 * cross-field consistency of one input. Whether a margin config is *complete
 * enough* for its contract kind is a separate, reported question —
 * `margin-rules.ts` answers it, and an incomplete config is accepted input
 * whose liquidation metrics come out `insufficient_data` rather than a
 * refusal that would also silence the independent metrics.
 */

const positiveFinite = z.number().finite().positive();
const epochMs = z.number().finite().int().nonnegative();
/** Fraction of notional or price. Rates above these bounds are typos. */
const rate = (max: number) => z.number().finite().min(0).max(max);

const candleSchema = z.object({
    timestamp: epochMs,
    open: positiveFinite,
    high: positiveFinite,
    low: positiveFinite,
    close: positiveFinite,
    volume: z.number().finite().min(0),
});

const atrRefSchema = z.object({
    value: z.number().finite().min(0),
    period: z.number().finite().int().positive(),
    interval: z.enum(SUPPORTED_CANDLE_INTERVALS),
    venue: z.enum(MARKET_VENUES),
    symbol: z.string().min(1),
    asOf: epochMs,
});

const qualitySchema = z.object({
    score: z.number().finite().min(0).max(1),
    floor: z.number().finite().min(0).max(1),
    usable: z.boolean(),
    worst: z.string().nullable().default(null),
    blockedBy: z.string().nullable().default(null),
    freshness: z.string().nullable().default(null),
});

const costsSchema = z
    .object({
        takerFeeRate: rate(0.1),
        makerFeeRate: rate(0.1),
        /**
         * The full relative spread of the market: half of it is crossed on
         * each side, so a full round trip pays the whole `spreadRate`.
         */
        spreadRate: rate(0.5),
        slippageRate: rate(0.5),
        executionReserveRate: rate(0.5),
        /**
         * `null` means "no funding reading was provided". It never means
         * zero: funding-dependent metrics degrade instead.
         */
        fundingRatePerInterval: z
            .number()
            .finite()
            .min(-1)
            .max(1)
            .nullable()
            .default(null),
    })
    .refine((costs) => costs.makerFeeRate <= costs.takerFeeRate, {
        message: 'makerFeeRate above takerFeeRate is almost always a typo',
        path: ['costs', 'makerFeeRate'],
    });

const marginRulesSchema = z
    .object({
        venue: z.string().min(1),
        contractKind: z.enum(CONTRACT_KINDS),
        mode: z.enum(MARGIN_MODES),
        maintenanceMarginRate: z.number().finite().min(0).max(1),
        initialMarginRate: z.number().finite().min(0).max(1),
        tiers: z
            .array(
                z.object({
                    notionalThresholdQuote: positiveFinite,
                    maintenanceMarginRate: z.number().finite().min(0).max(1),
                }),
            )
            .default([]),
        liquidationFormulaId: z.string().min(1),
        collateralCurrency: z.string().min(1),
        contractSizeUsd: positiveFinite.nullable().default(null),
        marginCurrency: z.enum(['base', 'quote']).nullable().default(null),
        version: z.string().min(1),
        source: z.literal('manual'),
        validAsOf: epochMs,
        reviewStatus: z.enum(['draft', 'reviewed']),
        limitations: z.array(z.string()).default([]),
    })
    .refine(
        (rules) => rules.maintenanceMarginRate < rules.initialMarginRate,
        {
            message:
                'maintenanceMarginRate must be below initialMarginRate; the reverse means a position is liquidatable at entry',
            path: ['maintenanceMarginRate'],
        },
    )
    .refine(
        (rules) =>
            rules.contractKind !== 'linear_perp' ||
            rules.liquidationFormulaId === LINEAR_ISOLATED_FORMULA_ID,
        {
            message: `linear_perp rules must name the implemented formula ${LINEAR_ISOLATED_FORMULA_ID}`,
            path: ['liquidationFormulaId'],
        },
    );

const historicalScenarioSchema = z.object({
    kind: z.literal('historical'),
    scenarioId: z.string().min(1),
    sourceVenue: z.string().min(1),
    datasetRef: z.string().min(1),
    fromBar: epochMs,
    toBar: epochMs,
    assumptions: z.array(z.string()).default([]),
});

const syntheticScenarioSchema = z.object({
    kind: z.literal('synthetic'),
    scenarioId: z.string().min(1),
    generatorId: z.string().min(1),
    generatorVersion: z.string().min(1),
    params: z.record(
        z.string(),
        z.union([z.number().finite(), z.string(), z.boolean(), z.null()]),
    ),
    assumptions: z.array(z.string()).default([]),
});

const scenarioSchema = z.discriminatedUnion('kind', [
    historicalScenarioSchema,
    syntheticScenarioSchema,
]);

const marginSchema = z
    .object({
        mode: z.enum(MARGIN_MODES).nullable().default(null),
        rules: marginRulesSchema.nullable().default(null),
    })
    .default({ mode: null, rules: null });

export const RiskInputSchema = z
    .object({
        positionId: z.string().min(1),
        ticker: z.string().min(1),
        venue: z.enum(MARKET_VENUES),
        contractKind: z.enum(CONTRACT_KINDS),
        interval: z.enum(SUPPORTED_CANDLE_INTERVALS),
        side: z.enum(POSITION_SIDES),
        /** Base units for spot/linear; contract count for inverse. */
        qtyBase: positiveFinite,
        /** Entry quote notional; inverse is USD contracts x USD size. */
        notionalQuote: positiveFinite,
        entryPrice: positiveFinite,
        currentPrice: positiveFinite,
        /** Must match the ticker; inverse USD contract sizes require USD. */
        quoteCurrency: z.string().min(1),
        collateralQuote: positiveFinite.nullable().default(null),
        invalidationLevelQuote: positiveFinite.nullable().default(null),
        /**
         * A what-if exit price for the potential-PnL metric. `null` means the
         * question was not asked, and the metric answers `not_applicable`
         * rather than quietly computing against the current price.
         */
        exitPriceQuote: positiveFinite.nullable().default(null),
        source: z.enum(POSITION_SOURCES),
        observedAt: epochMs,
        /** The wall-clock basis of `computedAt`. Explicit, so reruns are reproducible. */
        now: epochMs,
        market: z.object({
            candles: z.array(candleSchema).min(2),
            lastClosedBarTime: epochMs,
            provider: z.string().min(1),
        }),
        atr: atrRefSchema,
        costs: costsSchema,
        dataQuality: qualitySchema,
        margin: marginSchema,
        /** USD face value of one inverse contract; never an arbitrary quote amount. */
        contractSizeUsd: positiveFinite.nullable().default(null),
        marginCurrency: z.enum(['base', 'quote']).nullable().default(null),
        scenarios: z.array(scenarioSchema).default([]),
    })
    .superRefine((input, ctx) => {
        const addIssue = (message: string, path: (string | number)[]): void => {
            ctx.addIssue({ code: 'custom', message, path });
        };

        // The ticker is parsed by the one registry the project owns. A second
        // parser here would be a second answer to "what is BTCUSDT".
        const instrument = resolveInstrument(input.ticker);

        if (
            instrument === null ||
            instrument.base.status === 'unknown' ||
            instrument.quote.status === 'unknown'
        ) {
            addIssue(
                `ticker ${input.ticker} does not resolve against the asset registry to known base and quote`,
                ['ticker'],
            );
        } else if (instrument.quote.symbol !== input.quoteCurrency) {
            addIssue(
                `quoteCurrency ${input.quoteCurrency} does not match the registry's quote ${instrument.quote.symbol}`,
                ['quoteCurrency'],
            );
        }

        // No FX source is available: USD is not BTC, EUR or a stablecoin.
        if (input.contractKind === 'inverse_perp' && input.quoteCurrency !== 'USD') {
            addIssue(
                'inverse_perp requires quoteCurrency USD: contractSizeUsd is USD per contract; no FX conversion is available',
                ['quoteCurrency'],
            );
        }

        // The notional redundancy check is kind-aware. For spot and linear
        // the position's quote notional is qty x entry price. For an inverse
        // contract qty counts contracts, so the same check would multiply
        // incompatible quantities; there the notional must agree with
        // qty x contractSizeUsd, and only when the confirmed size is present.
        // The report's entryNotionalQuote carries the kind-aware figure.
        if (input.contractKind === 'inverse_perp') {
            if (input.contractSizeUsd !== null) {
                const inverseNotional = finiteProduct(input.qtyBase, input.contractSizeUsd, 1);

                // Both amounts are positive. Their difference cannot overflow;
                // divide before comparing rather than forming an absolute
                // tolerance, which could underflow for subnormal notionals.
                // A product rounded to zero or infinity is not checkable.
                const relativeDifference = inverseNotional.value === null
                    ? Infinity
                    : Math.abs(inverseNotional.value - input.notionalQuote) / input.notionalQuote;

                if (relativeDifference > 1e-6) {
                    addIssue(
                        inverseNotional.value === null
                            ? 'qtyBase x contractSizeUsd must have a representable positive notionalQuote'
                            : `notionalQuote ${input.notionalQuote} disagrees with qtyBase x contractSizeUsd (relative difference ${relativeDifference})`,
                        ['notionalQuote'],
                    );
                }
            }
        } else {
            const notionalTolerance = Math.max(1e-9, 1e-6 * input.notionalQuote);
            const notionalDelta = Math.abs(
                input.qtyBase * input.entryPrice - input.notionalQuote,
            );

            if (notionalDelta > notionalTolerance) {
                addIssue(
                    `notionalQuote ${input.notionalQuote} disagrees with qtyBase x entryPrice by ${notionalDelta}`,
                    ['notionalQuote'],
                );
            }
        }

        const { candles, lastClosedBarTime } = input.market;
        const last = candles.at(-1);

        if (last === undefined || last.timestamp !== lastClosedBarTime) {
            addIssue(
                'market.lastClosedBarTime must equal the timestamp of the last candle',
                ['market', 'lastClosedBarTime'],
            );
        }

        const intervalMs = CANDLE_INTERVAL_MS[input.interval];

        for (let index = 1; index < candles.length; index += 1) {
            const previous = candles[index - 1];
            const current = candles[index];

            if (previous === undefined || current === undefined) {
                continue;
            }

            if (
                current.timestamp - previous.timestamp !== intervalMs
            ) {
                addIssue(
                    `candles must be consecutive closed ${input.interval} bars (gap or overlap at index ${index})`,
                    ['market', 'candles', index],
                );
                break;
            }
        }

        if (input.atr.interval !== input.interval) {
            addIssue(
                `atr.interval ${input.atr.interval} does not match the input interval ${input.interval}`,
                ['atr', 'interval'],
            );
        }

        if (input.atr.venue !== input.venue) {
            addIssue(
                `atr.venue ${input.atr.venue} does not match the input venue ${input.venue}`,
                ['atr', 'venue'],
            );
        }

        if (input.atr.symbol !== input.ticker) {
            addIssue(
                `atr.symbol ${input.atr.symbol} does not match the input ticker ${input.ticker}`,
                ['atr', 'symbol'],
            );
        }

        if (input.atr.asOf < lastClosedBarTime || input.atr.asOf > input.now) {
            addIssue(
                'atr.asOf must fall between the last closed bar and now',
                ['atr', 'asOf'],
            );
        }

        if (input.observedAt < lastClosedBarTime || input.observedAt > input.now) {
            addIssue(
                'observedAt must fall between the last closed bar and now',
                ['observedAt'],
            );
        }

        const isPerp = input.contractKind !== 'spot';

        if (input.contractKind === 'spot') {
            if (input.margin.mode !== null) {
                addIssue(
                    'spot positions carry no margin mode',
                    ['margin', 'mode'],
                );
            }

            if (input.collateralQuote !== null) {
                addIssue(
                    'spot positions carry no collateral',
                    ['collateralQuote'],
                );
            }
        }

        if (isPerp) {
            if (input.collateralQuote === null) {
                addIssue(
                    `${input.contractKind} positions require collateralQuote`,
                    ['collateralQuote'],
                );
            }

            if (input.margin.mode === null) {
                addIssue(
                    `${input.contractKind} positions require margin.mode`,
                    ['margin', 'mode'],
                );
            }
        }

        const rules = input.margin.rules;

        if (rules !== null) {
            if (
                rules.venue.trim().toUpperCase() !== input.venue.toUpperCase() ||
                rules.contractKind !== input.contractKind ||
                (isPerp && rules.mode !== input.margin.mode)
            ) {
                addIssue(
                    'margin.rules describe a different venue, contract kind or margin mode than the position; rules are never borrowed',
                    ['margin', 'rules', 'venue'],
                );
            }
        }
    });

export type RiskInput = z.infer<typeof RiskInputSchema>;
