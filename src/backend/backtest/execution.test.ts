import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ExecutionConfig } from './execution.js';
import {
    EXECUTION_CONFIG,
    ExecutionConfigParser,
    fillPrice,
    pricedTrade,
    roundTripCost,
} from './execution.js';

const BAR = { open: 100, high: 110, low: 90, close: 105 };

/** A well-formed bar: low ≤ open,close ≤ high, and the four strictly ordered. */
const candleArbitrary: fc.Arbitrary<{
    open: number;
    high: number;
    low: number;
    close: number;
}> = fc
    .tuple(
        fc.integer({ min: 50, max: 100_000 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
    )
    .map(([base, upper, lower]) => {
        const open = base + upper / 2;
        const low = base - lower / 2;

        return {
            open,
            high: base + upper,
            low,
            close: base + (lower - upper) / 4,
        };
    })
    .filter((candle) => candle.low <= candle.close && candle.close <= candle.high);

function config(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
    return ExecutionConfigParser.parse({
        makerFeeRate: 0.00075,
        takerFeeRate: 0.001,
        slippageRate: 0.0005,
        spreadRate: 0.0002,
        liquidity: 'taker',
        model: 'next_open',
        ...overrides,
    });
}

function free(model: ExecutionConfig['model']): ExecutionConfig {
    return ExecutionConfigParser.parse({
        makerFeeRate: 0,
        takerFeeRate: 0,
        slippageRate: 0,
        spreadRate: 0,
        liquidity: 'taker',
        model,
    });
}

describe('a cost is charged on the price, not on the return', () => {
    it('costs a big trade more in money than a small one', () => {
        // A flat percentage taken off the return charges the same fraction on a
        // trade that tripled as on one that moved a tenth of a percent, while
        // the venue takes thirty times the money off the first.
        const cheap = fillPrice(BAR, 1, config(), true) - BAR.open;
        const dear = fillPrice({ ...BAR, open: 3000 }, 1, config(), true) - 3000;

        expect(dear).toBeCloseTo(cheap * 30, 6);
    });

    it('is negative on a market that went nowhere at all', () => {
        const flat = { open: 100, high: 100, low: 100, close: 100 };
        const trade = pricedTrade(flat, flat, 1, config());

        // A strategy that trades a market with no movement and pays for it.
        // The round trip is the cost paid twice: 0.17% to buy at 100.17 and
        // 0.17% to sell at 99.83, which is a little under 0.34% of the entry.
        expect(trade.grossReturn).toBeCloseTo(0, 12);
        expect(trade.netReturn).toBeLessThan(0);
        expect(trade.netReturn).toBeCloseTo(99.83 / 100.17 - 1, 10);
    });

    it('can only make a trade worse', () => {
        fc.assert(
            fc.property(
                fc.double({
                    min: 0.01,
                    max: 1000,
                    noNaN: true,
                    noDefaultInfinity: true,
                }),
                fc.double({
                    min: 0.01,
                    max: 1000,
                    noNaN: true,
                    noDefaultInfinity: true,
                }),
                fc.constantFrom(1 as const, -1 as const),
                fc.constantFrom('next_open', 'next_close', 'intrabar'),
                (entryPrice, exitPrice, direction, model) => {
                    const bar = (value: number) => ({
                        open: value,
                        high: value * 1.1,
                        low: value * 0.9,
                        close: value,
                    });

                    const priced = pricedTrade(
                        bar(entryPrice),
                        bar(exitPrice),
                        direction,
                        config({ model }),
                    );
                    const freeTrade = pricedTrade(
                        bar(entryPrice),
                        bar(exitPrice),
                        direction,
                        free(model),
                    );

                    // The invariant the whole module exists to keep. A cost
                    // model that sometimes pays the trader is a bug that
                    // always makes the result look better.
                    expect(priced.netReturn).toBeLessThanOrEqual(
                        freeTrade.netReturn + 1e-12,
                    );
                },
            ),
            { numRuns: 300 },
        );
    });
});

describe('the side of a trade decides the direction of every cost', () => {
    it('pays up to enter a long and down to leave one', () => {
        const entry = fillPrice(BAR, 1, config(), true);
        const exit = fillPrice(BAR, 1, config(), false);

        expect(entry).toBeGreaterThan(BAR.open);
        expect(exit).toBeLessThan(BAR.open);
    });

    it('pays down to enter a short and up to leave one', () => {
        const entry = fillPrice(BAR, -1, config(), true);
        const exit = fillPrice(BAR, -1, config(), false);

        expect(entry).toBeLessThan(BAR.open);
        expect(exit).toBeGreaterThan(BAR.open);
    });

    it('charges a short very slightly more than a long for the same move', () => {
        // Costs are multiplicative, so they compound against the trader rather
        // than being subtracted from the result. A short buys high and sells
        // low, which costs a fraction more than a long does. The difference is
        // second order, and it is real: the point is that it is not silently
        // rounded away into a symmetry the model does not have.
        const up = pricedTrade(BAR, { ...BAR, open: 120, close: 120 }, 1, config());
        const down = pricedTrade(
            BAR,
            { ...BAR, open: 120, close: 120 },
            -1,
            config(),
        );

        expect(up.netReturn).toBeCloseTo(-down.netReturn, 1);
        expect(down.netReturn).toBeLessThan(-up.netReturn);
    });
});

describe('maker is not taker, and the config says which it is', () => {
    it('fills a resting order more cheaply than a crossing one', () => {
        const maker = fillPrice(BAR, 1, config({ liquidity: 'maker' }), true);
        const taker = fillPrice(BAR, 1, config({ liquidity: 'taker' }), true);

        // The reason a limit order exists.
        expect(maker).toBeLessThan(taker);
    });

    it('refuses a maker fee above the taker fee', () => {
        expect(() =>
            ExecutionConfigParser.parse({
                makerFeeRate: 0.002,
                takerFeeRate: 0.001,
                slippageRate: 0,
                spreadRate: 0,
                liquidity: 'taker',
                model: 'next_open',
            }),
        ).toThrow(/nearly always a typo/);
    });

    it('refuses a resting order filled at the bar extreme by bad luck', () => {
        // A limit order is filled because the price traded there, not because
        // the bar happened to go the wrong way first. Charging the pessimistic
        // fill on top of the optimistic one describes an order that is not a
        // thing.
        expect(() =>
            ExecutionConfigParser.parse({
                makerFeeRate: 0.00075,
                takerFeeRate: 0.001,
                slippageRate: 0,
                spreadRate: 0,
                liquidity: 'maker',
                model: 'intrabar',
            }),
        ).toThrow(/rested and is filled|market order|resting order/i);
    });
});

describe('the three execution models are three different claims', () => {
    it('next_open fills at the open', () => {
        expect(fillPrice(BAR, 1, config({ model: 'next_open' }), true)).toBeCloseTo(
            100 * 1.0017,
            10,
        );
    });

    it('next_close fills at the close', () => {
        expect(fillPrice(BAR, 1, config({ model: 'next_close' }), true)).toBeCloseTo(
            105 * 1.0017,
            10,
        );
    });

    it('intrabar assumes the bar went the wrong way first', () => {
        const longEntry = fillPrice(BAR, 1, config({ model: 'intrabar' }), true);
        const longExit = fillPrice(BAR, 1, config({ model: 'intrabar' }), false);
        const shortEntry = fillPrice(BAR, -1, config({ model: 'intrabar' }), true);
        const shortExit = fillPrice(BAR, -1, config({ model: 'intrabar' }), false);

        // The only thing OHLC says about the order of events is that both
        // happened. Being wrong about the order is the assumption, and wrong
        // means the worse price *for whoever is filling* — not for the side.
        //
        // Buying at the low and selling at the low is neither: it books the
        // long's entry at the best price on the bar and the long's exit at the
        // worst, and on this project — which is long-only, on every rule in it
        // — that asymmetry is worth more than the rule. It was worth 43 points
        // on donchian-20 over the full Binance history: +15.29% as it stood,
        // -27.57% under the same model done honestly. The "pessimistic" label
        // was doing work the arithmetic was not.
        expect(longEntry).toBeCloseTo(BAR.high * 1.0017, 10);
        expect(longExit).toBeCloseTo(BAR.low * 0.9983, 10);
        expect(shortEntry).toBeCloseTo(BAR.low * 0.9983, 10);
        expect(shortExit).toBeCloseTo(BAR.high * 1.0017, 10);
    });

    it('never fills a pessimistic model better than the close, on either leg', () => {
        // The invariant the previous test used to leave out, written now that
        // it holds. A model described as pessimistic that hands out a better
        // price than a neutral one is not pessimistic, whatever it is called,
        // and the previous version of this file proved it could be violated
        // by checking only that no single side was favoured.
        for (const candle of fc.sample(candleArbitrary, { numRuns: 200 })) {
            for (const side of [1, -1] as const) {
                for (const isEntry of [true, false]) {
                    const pessimistic = fillPrice(
                        candle,
                        side,
                        config({ model: 'intrabar' }),
                        isEntry,
                    );
                    const neutral = fillPrice(
                        candle,
                        side,
                        config({ model: 'next_close' }),
                        isEntry,
                    );

                    // Pessimistic means worse *for the trader*, and which end
                    // of the number that is depends on what the fill does:
                    // a buyer is made worse by a higher price and a seller by a
                    // lower one. Comparing the two raw numbers without asking
                    // which is which would make a correct fill look wrong.
                    // Equality is allowed — a bar with no wick has no worse
                    // price to be given, and demanding strictness would be
                    // demanding a bar that cannot exist.
                    const isBuying = (side === 1) === isEntry;

                    if (isBuying) {
                        expect(pessimistic).toBeGreaterThanOrEqual(neutral);
                    } else {
                        expect(pessimistic).toBeLessThanOrEqual(neutral);
                    }
                }
            }
        }
    });

    it('orders the three by how much each one can flatter a result', () => {
        // The claim is now the strong one, because the strong one is true: the
        // pessimistic model is never the best price available on either side,
        // in either direction, on any leg. It was previously weakened to "not
        // the most favourable for both sides at once" because that was the
        // most the old implementation could carry, and a weakened assertion is
        // how a model kept the word "pessimistic" while handing out the better
        // half of every bar.
        const models = ['next_open', 'next_close', 'intrabar'] as const;

        for (const side of [1, -1] as const) {
            for (const isEntry of [true, false]) {
                const fills = models.map((model) =>
                    fillPrice(BAR, side, config({ model }), isEntry),
                );
                const isBuying = (side === 1) === isEntry;
                // A buyer is best off at the lowest fill available, a seller at
                // the highest.
                const best = isBuying ? Math.min(...fills) : Math.max(...fills);

                expect(fills[2]).not.toBe(best);
            }
        }
    });
});

describe('what survives the costs is the finding', () => {
    it('reports a positive gross and a negative net for an edge under the fees', () => {
        // 0.3% a move against a 0.34% round trip. A report that showed only
        // the net number would say the strategy loses and stop there; the pair
        // says the signal has something to say and the venue is taking it.
        const trade = pricedTrade(
            { ...BAR, open: 100, close: 100 },
            { ...BAR, open: 100, close: 100.3 },
            1,
            config(),
        );

        expect(trade.grossReturn).toBeCloseTo(0.003, 10);
        expect(trade.netReturn).toBeLessThan(0);
    });

    it('quotes a round trip that matches a flat trade, to second order', () => {
        const flat = { open: 100, high: 100, low: 100, close: 100 };
        const trade = pricedTrade(flat, flat, 1, config());

        // The two agree to within a second-order term, and the flat
        // approximation marginally *overstates* the cost: `(1-c)/(1+c)` is
        // `1 - 2c + 2c²`, and the quadratic term lands on the trader's side.
        // Measured, after I had written the opposite into a comment.
        const approximation = 1 - roundTripCost(config());
        const actual = 1 + trade.netReturn;

        expect(actual).toBeGreaterThan(approximation);
        expect(actual).toBeCloseTo(approximation, 4);
    });

    it('is why trades are priced rather than discounted', () => {
        // The reason is the price dependence, not the second order. A trade
        // that ran to three times its entry was closed against three times the
        // money, and a rate applied to the return reports the same cost for it
        // as for a trade that never moved.
        const entry = { open: 100, high: 100, low: 100, close: 100 };
        const tripled = { open: 300, high: 300, low: 300, close: 300 };
        const trade = pricedTrade(entry, tripled, 1, config());

        // Overpaid on the way in, under-received on the way out. Both are
        // money, and both are positive costs — the second one is negative in
        // the sell price precisely because that is what it costs.
        const overpaid = trade.entryPrice - entry.open;
        const underReceived = tripled.open - trade.exitPrice;

        // Sixty-eight cents: seventeen to open, fifty-one to close. A flat
        // 0.34% of the entry would have reported thirty-four.
        expect(overpaid).toBeCloseTo(0.17, 6);
        expect(underReceived).toBeCloseTo(0.51, 6);
        expect(overpaid + underReceived).toBeCloseTo(0.68, 6);
        expect(overpaid + underReceived).toBeGreaterThan(0.34);
    });
});

describe('the shipped defaults', () => {
    it('assume the fill nobody has to defend and the full fee', () => {
        // `next_open` rather than `intrabar`. The third model is kept and is
        // still the harshest of the three, but it is a bound rather than a
        // description: it charges the adverse end of both bars on both legs,
        // which is two full bar ranges a trade and returns -99.96% on daily
        // BTCUSDT. A default has to be a claim somebody could defend in
        // daylight, and nobody fills at the worst tick of every bar they touch.
        //
        // The fee side is unchanged and for the same reason: a backtest that
        // assumed a maker discount it did not get would report a strategy that
        // does not work.
        expect(EXECUTION_CONFIG.model).toBe('next_open');
        expect(EXECUTION_CONFIG.liquidity).toBe('taker');
        expect(EXECUTION_CONFIG.makerFeeRate).toBeGreaterThanOrEqual(
            EXECUTION_CONFIG.takerFeeRate,
        );
    });
});
