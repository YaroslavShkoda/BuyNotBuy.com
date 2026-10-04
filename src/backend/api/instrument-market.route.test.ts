import Fastify from 'fastify';

import { describe, expect, it, vi } from 'vitest';
import { currentCandles } from '../test-support/candles.js';

import { MarketDataSchema } from './schemas.js';

/**
 * `/api/instruments/:ticker/market` — the market-data sibling of the analysis
 * route, built the same way: additive, beside the frozen `/api/market`.
 *
 * The stub echoes the market it was asked for, for the same reason the analysis
 * route's stub does: `fetchMarketData` refuses a provider that answers with
 * somebody else's symbol, so a fixed-`BTCUSDT` stub makes every ETH case fail
 * with `MARKET_DATA_UNAVAILABLE` and the test would assert its own setup error.
 */
const { mockMarketDataProvider, mockAnyProviderAvailable } = vi.hoisted(() => {
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

async function app() {
    const application = Fastify();
    const { instrumentRoutes } = await import('./routes/instruments.js');

    await application.register(instrumentRoutes);

    return application;
}

describe('GET /api/instruments/:ticker/market', () => {
    it('answers with that market price, not the configured one', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments/BTCUSDT/market',
        });

        expect(response.statusCode).toBe(200);
        expect((response.json() as { price: { symbol: string } }).price.symbol).toBe('BTCUSDT');
        expect((response.json() as { price: { price: number } }).price.price).toBeLessThan(2000);
    });

    it('passes the schema the frozen route is held to', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments/BTCUSDT/market',
        });

        expect(() => MarketDataSchema.parse(response.json())).not.toThrow();
    });

    it('gives a different answer for a different market', async () => {
        const application = await app();

        const btc = await application.inject({
            method: 'GET',
            url: '/api/instruments/BTCUSDT/market',
        });
        const eth = await application.inject({
            method: 'GET',
            url: '/api/instruments/ETHUSDT/market',
        });

        expect(eth.statusCode).toBe(200);
        expect((eth.json() as { price: { symbol: string } }).price.symbol).toBe('ETHUSDT');
        expect((eth.json() as { price: { price: number } }).price.price).toBeGreaterThan(2000);
        expect((btc.json() as { price: { price: number } }).price.price).toBeLessThan(2000);
    });

    it('normalises the ticker, as the sibling routes do', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments/btcusdt/market',
        });

        expect(response.statusCode).toBe(200);
        expect((response.json() as { price: { symbol: string } }).price.symbol).toBe('BTCUSDT');
    });

    it('leaves the instrument route next to it working', async () => {
        const response = await (await app()).inject({
            method: 'GET',
            url: '/api/instruments',
        });

        expect(response.statusCode).toBe(200);
    });
});
