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
 * intrabar extremes charges you the adverse end of every bar you touch, on
 * every leg — which is a bound on how bad it could go, not a description of how
 * it goes, and is the reason `next_open` is the default. A backtest that offers
 * only the flattering two is offering the other one silently, which is what
 * happened here for as long as `intrabar` was the default.
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
    /**
     * `next_open` is the default, and it is the default because it is the only
     * one of the three that makes no claim it cannot support.
     *
     * `intrabar` used to be the default, described as pessimistic. It was
     * neither pessimistic nor optimistic — it keyed off the side rather than off
     * what the fill did, booking the favourable extreme on the entry of both
     * sides and only the unfavourable one on the exit. On a long-only book that
     * handed out the better half of every bar, and it was worth 43 points on
     * donchian-20 over the full Binance history: +15.29% that way, -27.57% under
     * `next_open`, same 144 trades.
     *
     * Made symmetric it becomes useless instead. A long entering at the high and
     * exiting at the low pays two full bar ranges a trade, and a daily bar's
     * range averages 3.05% against a 0.56% hourly one — so it returns -99.96% on
     * BTCUSDT. That is not a pessimistic fill, it is a trader who is filled at
     * the single worst tick of every bar they touch, twice. No one is that
     * unlucky on every trade, and a model that assumes it is not pessimistic
     * either. It is a stress bound, and it is kept under its own name for that.
     *
     * `next_open` assumes the signal lands at a close and the order fills at the
     * next open, which is the ordinary convention and asserts nothing about the
     * order of the high and the low.
     */
    model: process.env.BACKTEST_EXECUTION_MODEL ?? 'next_open',
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
    // Whether this fill is a purchase. True for a long entry and a short exit,
    // which is the only place the two decisions meet.
    const isBuying = (side === 1) === isEntry;

    const base =
        config.model === 'next_open'
            ? candle.open
            : config.model === 'next_close'
              ? candle.close
              : // The extreme that is worse for whoever is filling. Buying at
                // the high and selling at the low is the pessimistic assumption
                // about the order of events, and the word is doing the work:
                // the only thing OHLC says is that the high and the low both
                // happened, so assuming the bad one arrived first is a choice,
                // while assuming the good one is a wish.
                //
                // This used to key off `side` alone — a long filled at the low,
                // a short at the high — which books the favourable extreme on
                // the *entry* of both sides and only the unfavourable one on
                // the exit. On a long-only book that is a systematic gift: the
                // same donchian-20 run over 2096 Binance bars returned +15.29%
                // that way and -27.57% once it is pessimistic on both legs, and
                // the first number is the one this project quoted for a step.
                isBuying
                ? candle.high
                : candle.low;

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
