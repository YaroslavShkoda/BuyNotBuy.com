import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two markets, one process, one answer each.
 *
 * The hazard this file exists for was not hypothetical. `analysisFlight` was an
 * unkeyed `createSingleFlight` and `computeAnalysis` took no market at all, so the
 * coalescer was correct only because there was nothing to coalesce wrongly.
 * Threading an instrument through without keying it would have been the classic
 * version of that bug: two concurrent analyses join one flight, and the second
 * caller receives the first market's analysis — correct shape, plausible price,
 * wrong market — with nothing in the response to say so.
 *
 * These cases run the two markets **concurrently** rather than one after the
 * other. Sequential calls would pass against the unkeyed coalescer, because the
 * first flight has settled and been forgotten before the second arrives; the
 * whole point is that the overlap is what makes it wrong.
 */
const { analyzeMarket } = await import('./analysis.service.js');
const marketService = await import('../market/market.service.js');
const { marketData, marketDataResult } = await import('../test-support/market-data.js');

type Mock = ReturnType<typeof vi.spyOn>;

/** A flat series, so the only thing that differs between the two is the market. */
const candlesFor = (base: number) =>
    Array.from({ length: 900 }, (_, index) => ({
        timestamp: index,
        open: base,
        high: base + 1,
        low: base - 1,
        close: base,
        volume: 1000,
    }));

/**
 * Answers per market, and only for a market it was asked about.
 *
 * The refusal is the point: a stub that answered every request with the same
 * body would make "both callers got an answer" true in a world where the coalescer
 * was broken, so the price a caller receives is the only thing that can prove
 * which market it read.
 */
let served: Mock;

function serveByMarket(): Mock {
    return vi.spyOn(marketService, 'getMarketData').mockImplementation(
        async (request?: { instrument?: string | undefined }) => {
            const instrument = (request?.instrument ?? 'BTCUSDT').toUpperCase();
            const base = instrument === 'ETHUSDT' ? 3000 : 100;

            if (instrument !== 'BTCUSDT' && instrument !== 'ETHUSDT') {
                throw new Error(`no stub for ${instrument}`);
            }

            return marketDataResult(
                marketData(candlesFor(base), {
                    price: { symbol: instrument, price: base },
                    provider: 'binance',
                }),
            );
        },
    ) as Mock;
}

beforeEach(() => {
    served = serveByMarket();
});

describe('two markets analysed at once', () => {
    it('each caller gets the analysis of the market it named', async () => {
        const [btc, eth] = await Promise.all([
            analyzeMarket(undefined, undefined, undefined, 'BTCUSDT'),
            analyzeMarket(undefined, undefined, undefined, 'ETHUSDT'),
        ]);

        expect(btc.price).toBe(100);
        expect(eth.price).toBe(3000);
    });

    it('and a third caller joining the second market gets the second market', async () => {
        // Two of the three named the same market, so the coalescer has to put
        // them together — while keeping the other market apart. A single
        // process-wide coalescer cannot satisfy both halves of that.
        const results = await Promise.all([
            analyzeMarket(undefined, undefined, undefined, 'BTCUSDT'),
            analyzeMarket(undefined, undefined, undefined, 'ETHUSDT'),
            analyzeMarket(undefined, undefined, undefined, 'ETHUSDT'),
        ]);

        expect(results.map((one) => one.price)).toEqual([100, 3000, 3000]);
    });

    it('while the coalescer reports one market per market', async () => {
        const { analysisFlightKeys } = await import('./analysis.service.js');

        await Promise.all([
            analyzeMarket(undefined, undefined, undefined, 'BTCUSDT'),
            analyzeMarket(undefined, undefined, undefined, 'ETHUSDT'),
        ]);

        expect(analysisFlightKeys()).toContain('BTCUSDT|1h');
        expect(analysisFlightKeys()).toContain('ETHUSDT|1h');
        expect(analysisFlightKeys()).toHaveLength(2);
    });
});

describe('a caller that names no market', () => {
    it('reads the configured one, unchanged', async () => {
        const { marketConfig } = await import('../config/market.config.js');

        const analysis = await analyzeMarket();

        expect(analysis.price).toBe(100);
        expect(served).toHaveBeenCalled();
        expect(marketConfig.symbol).toBe('BTCUSDT');
    });
});