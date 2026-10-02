import { currentCandles } from '../test-support/candles.js';

import { describe, expect, it, vi } from 'vitest';

import Fastify from 'fastify';

/**
 * `/api/instruments/:ticker/analysis`, the route the market axis exists to make
 * possible.
 *
 * The stub **echoes the market it was asked for**, and that is not a detail of
 * the fixture. `fetchMarketData` refuses a provider that answers with somebody
 * else's symbol — the check `invariants.md` §19 describes — so a stub with a
 * fixed `BTCUSDT` in it makes every ETH request fail with
 * `MARKET_DATA_UNAVAILABLE`, and a test written that way either asserts 502 or,
 * worse, asserts two refusals and calls it compatibility.
 *
 * First version did exactly that and returned 502 on all three cases. It looked
 * like a missing route; it was a stub that could not answer a question it was
 * being asked. The prices differ per market so the assertion is on the number,
 * not on the status: the failure this guards is 200 with a plausible body for the
 * wrong market, and a status check passes against it.
 */
const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
    /**
     * One series per market, and the *candles* differ rather than a ticker.
     *
     * The price in the response is `lastCandle.close` by design — the dashboard
     * is a snapshot of the last closed hour, so the signal, the chart and the
     * price are computed against one time base. A stub that returned a different
     * `getAttributedPrice` per market would therefore change nothing observable,
     * which is the second time in this file that the first version of the stub
     * could not answer the question it was being asked.
     */
    const baseOf = (instrument: string): number =>
        instrument === 'ETHUSDT' ? 3000 : 100;

    const providerFor = (instrument: string) => ({
        getPrice: vi.fn(async () => ({ symbol: instrument, price: baseOf(instrument) })),
        getCandles: vi.fn(async (limit = 900) => currentCandles(limit, baseOf(instrument))),
        getAttributedCandles: vi.fn(async (limit?: number) => ({
            venue: 'binance',
            symbol: instrument,
            candles: currentCandles(limit ?? 900, baseOf(instrument)),
        })),
        getAttributedPrice: vi.fn(async () => ({
            venue: 'binance',
            symbol: instrument,
            price: baseOf(instrument),
        })),
    });

    return {
        mockAnyProviderAvailable: vi.fn(() => true),
        mockMarketDataProvider: providerFor('BTCUSDT'),
    };
});

vi.mock('../market/market.provider.js', () => ({
    // The router hands the service a provider for the market it was asked about,
    // and the stub answers as that market. Handing back one fixed provider — the
    // shape the older route test uses, correctly, because every case there is
    // BTC — is what made this return 502 for ETH.
    marketProviderFor: (instrument: string) => {
        const base = instrument === 'ETHUSDT' ? 3000 : 100;

        return {
            getPrice: vi.fn(async () => ({ symbol: instrument, price: base })),
            getCandles: vi.fn(async (limit = 900) => currentCandles(limit, base)),
            getAttributedCandles: vi.fn(async (limit?: number) => ({
                venue: 'binance',
                symbol: instrument,
                candles: currentCandles(limit ?? 900, base),
            })),
            getAttributedPrice: vi.fn(async () => ({
                venue: 'binance',
                symbol: instrument,
                price: base,
            })),
        };
    },
    marketDataProvider: mockMarketDataProvider,
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    configuredMarketVenues: vi.fn(() => ['binance']),
    configuredVenueCapabilities: vi.fn(() => []),
}));

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
    summarizeHistory: vi.fn(() => ({ total: 0 })),
    signalHistoryBacklog: vi.fn(() => 0),
}));

vi.mock('../indicators/performance/indicator-performance.service.js', () => ({
    recordIndicatorVotes: vi.fn(),
    indicatorVoteBacklog: vi.fn(() => 0),
}));

async function app() {
    const application = Fastify();
    const { instrumentRoutes } = await import('./routes/instruments.js');

    await application.register(instrumentRoutes);

    return application;
}

describe('GET /api/instruments/:ticker/analysis', () => {
    it('answers with that market price, not the configured one', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments/BTCUSDT/analysis',
        });

        expect(response.statusCode).toBe(200);
        // Read as a range rather than an exact number: the last closed bar is
        // base + bars, and how many bars are asked for is not what this test is
        // about. What it is about is that the answer is about the market named.
        expect((response.json() as { price: number }).price).toBeLessThan(2000);
    });

    it('and gives a different answer for a different market', async () => {
        const application = await app();

        const btc = await application.inject({
            method: 'GET',
            url: '/api/instruments/BTCUSDT/analysis',
        });
        const eth = await application.inject({
            method: 'GET',
            url: '/api/instruments/ETHUSDT/analysis',
        });

        expect(eth.statusCode).toBe(200);
        expect((eth.json() as { price: number }).price).toBeGreaterThan(2000);
        expect((btc.json() as { price: number }).price).toBeLessThan(2000);
    });

    /**
     * The body cannot say which market it is about, and that is not an oversight
     * here — it is the frozen contract. `MarketAnalysisSchema` has no `symbol`
     * field, so a client reading this route has to have asked for the ticker to
     * know the market, and a cached body has nothing in it that says what it is a
     * reading of. Whether the contract should carry the market is the owner's
     * second decision; adding a field to a frozen schema would answer it here
     * rather than ask it.
     */
    it('and cannot name its market, which is the frozen contract speaking', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments/BTCUSDT/analysis',
        });

        expect(response.json()).not.toHaveProperty('symbol');
    });

    it('normalises the ticker, as the sibling route does', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments/btcusdt/analysis',
        });

        expect(response.statusCode).toBe(200);
    });

    it('leaves the instrument route next to it working', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments',
        });

        expect(response.statusCode).toBe(200);
    });
});