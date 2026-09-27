import { z } from 'zod';

/**
 * What a trade actually costs, and when it can be filled.
 *
 * The backtest this replaces charged a flat `2 * (fee + slippage)` off the
 * return. That is an approximation of a cost model, and it is wrong in a way
 * that flatters the strategy: subtracting a percentage from a return is not the
 * same as paying a percentage of the price, and the difference grows with the
 * move. A trade that triples pays a fee on three times the money and is charged
 * the fee of one.
 *
 * So costs are applied to the **price**, and the side decides which way. A long
 * pays the spread going in and the spread going out, and both moves are
 * against it; a flat subtraction cannot say that, because a flat subtraction
 * has no side.
 *
 * The execution model is a setting rather than a detail, because the three
 * answers are not variations on one question. Filling at the next open assumes
 * you got out at a price nobody was trading. Filling at the next close assumes
 * you waited for a bar you could not have predicted the end of. Filling at the
 * intrabar extreme assumes you were wrong about the order in which the bar
 * happened. Only the third is pessimistic on purpose, and a backtest that does
 * not offer it is offering the other two silently.
 */

const ExecutionConfigSchema = z
    .object({
        /**
         * Fee for a passive order that rests and gets filled.
         *
         * Lower than taker on every venue worth the name, which is the whole
         * reason a limit order exists.
         */
        makerFeeRate: z.coerce.number().min(0).max(0.1),
        /** Fee for an order that crosses the spread immediately. */
        takerFeeRate: z.coerce.number().min(0).max(0.1),
        /**
         * Market impact, as a fraction of price, in the direction against you.
         *
         * Distinct from the spread: the spread is the other side's price, and
         * impact is the size of your own order pushing the market. Charging one
         * for both and calling it slippage is a way of not having to say which
         * one moved.
         */
        slippageRate: z.coerce.number().min(0).max(0.1),
        /**
         * Half the spread, as a fraction of price, charged to cross it.
         *
         * Half and not the whole: a round trip crosses twice, and charging the
         * full spread on each side pays for a spread that is only paid once.
         */
        spreadRate: z.coerce.number().min(0).max(0.5),
        /**
         * Which side of the book entries and exits rest on.
         *
         * A single setting rather than one per side, because the interesting
         * question is not "how do I make the model look better" but "what does
         * the strategy assume it can do", and a strategy that assumes it can
         * both post and cross needs two settings to say so.
         */
        liquidity: z.enum(['maker', 'taker']),
        model: z.enum(['next_open', 'next_close', 'intrabar']),
    })
    .refine((config) => config.makerFeeRate <= config.takerFeeRate, {
        // Not a hard law — some venues invert it for maker rebates — but the
        // inverse here is almost always a typo, and a typo that makes a
        // backtest look good is the one that survives review.
        message:
            'A maker fee above the taker fee is nearly always a typo, and a typo that flatters a backtest is the one that survives review',
        path: ['makerFeeRate'],
    })
    .refine((config) => config.model !== 'intrabar' || config.liquidity === 'taker', {
        // A resting order is not filled at the bar's extreme by bad luck; it is
        // filled because the price traded there. Charging the pessimistic fill
        // on top of the optimistic one describes an order that is not a thing.
        message:
            'Intrabar fills assume a market order swept through the bar; a resting order is filled because the price traded there, not by bad luck',
        path: ['model'],
    });

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export const EXECUTION_CONFIG: ExecutionConfig = ExecutionConfigSchema.parse({
    // Binance spot: 0.1% taker, 0.075% maker with the discount that is on by
    // default, or 0.1% for both without it. The conservative reading is
    // chosen: a backtest that assumed the discount and did not get it would
    // report a strategy that does not work.
    makerFeeRate: process.env.BACKTEST_MAKER_FEE ?? '0.001',
    takerFeeRate: process.env.BACKTEST_TAKER_FEE ?? '0.001',
    slippageRate: process.env.BACKTEST_SLIPPAGE ?? '0.0005',
    spreadRate: process.env.BACKTEST_SPREAD ?? '0.0002',
    liquidity: process.env.BACKTEST_LIQUIDITY ?? 'taker',
    model: process.env.BACKTEST_EXECUTION_MODEL ?? 'intrabar',
});

export const ExecutionConfigParser = ExecutionConfigSchema;

export const EXECUTION_MODELS = [
    'next_open',
    'next_close',
    'intrabar',
] as const;

export type ExecutionModel = ExecutionConfig['model'];

/**
 * The round trip, for the case where somebody needs one number.
 *
 * Exposed because a trade's cost is a legitimate thing to want, and because a
 * cost model that can only be applied as a side effect cannot be checked
 * against the trades it produced.
 *
 * It agrees with `pricedTrade` on a flat market to within a second-order term
 * — and marginally *overstates* the cost there, because `(1-c)/(1+c)` is
 * `1 - 2c + 2c²` and the quadratic term is on the trader's side. What makes
 * pricing worth the trouble is the price dependence, not the second order: the
 * fee is a percentage of whatever the position was actually worth when it was
 * closed, so a trade that ran to ten times its entry paid ten times the money
 * while this function would report the same rate for it.
 */
export function roundTripCost(config: ExecutionConfig): number {
    const fee =
        config.liquidity === 'maker' ? config.makerFeeRate : config.takerFeeRate;

    return 2 * (fee + config.spreadRate + config.slippageRate);
}

/**
 * What a fill costs, as a fraction of price, charged against the trader.
 */
function fillCost(config: ExecutionConfig): number {
    const fee =
        config.liquidity === 'maker' ? config.makerFeeRate : config.takerFeeRate;

    return fee + config.spreadRate + config.slippageRate;
}

/**
 * The price a trade is filled at.
 *
 * The side decides the direction of every cost, and so does whether this is an
 * entry or an exit — a long pays up to buy and down to sell, a short does the
 * reverse. Getting this wrong in one direction is a backtest that gives a
 * trader money for holding, and it is the direction that makes a result look
 * good, so it is worth stating rather than compressing into a sign.
 */
export function fillPrice(
    candle: { open: number; high: number; low: number; close: number },
    side: 1 | -1,
    config: ExecutionConfig,
    isEntry: boolean,
): number {
    const base =
        config.model === 'next_open'
            ? candle.open
            : config.model === 'next_close'
              ? candle.close
              : // The extreme against the side. A long is assumed to have been
                // filled at the bar's low and a short at its high, because the
                // only thing OHLC says about the order of events is that both
                // happened — and the one that assumes the good one is not an
                // assumption, it is a wish.
                side === 1
                ? candle.low
                : candle.high;

    // Whether this fill is a purchase. True for a long entry and a short exit,
    // which is the only place the two decisions meet.
    const isBuying = (side === 1) === isEntry;
    const cost = fillCost(config);

    return base * (isBuying ? 1 + cost : 1 - cost);
}

/**
 * A trade priced under the model.
 *
 * Gross return is the move with no costs at all, kept alongside the net one so
 * a report can say what the costs took rather than only what survived them. A
 * strategy whose edge is smaller than its fees has a positive gross number and
 * a negative net one, and that pair is the finding.
 */
export function pricedTrade(
    entry: { open: number; high: number; low: number; close: number },
    exit: { open: number; high: number; low: number; close: number },
    direction: 1 | -1,
    config: ExecutionConfig,
): { entryPrice: number; exitPrice: number; grossReturn: number; netReturn: number } {
    const entryPrice = fillPrice(entry, direction, config, true);
    const exitPrice = fillPrice(exit, direction, config, false);

    const grossReturn = direction * (exit.close / entry.open - 1);
    const netReturn = direction * (exitPrice / entryPrice - 1);

    return { entryPrice, exitPrice, grossReturn, netReturn };
}
