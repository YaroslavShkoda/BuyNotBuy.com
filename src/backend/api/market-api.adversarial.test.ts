import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * YAR-72 - adversarial additions to the market API contract. The dimensions
 * already carried by existing suites are mapped, not duplicated here:
 *
 *   429 / Retry-After            -> middleware/http-hardening.test.ts, errors.test.ts (case 7)
 *   502 / 503 / 504 mapping      -> errors.test.ts, runtime-reliability.test.ts,
 *                                   integration-boundaries.test.ts, market/failover.*.test.ts
 *   stale snapshot + X-Data-Stale -> runtime-reliability.test.ts, routes/analysis.test.ts,
 *                                   contract-semantics.test.ts (304 never caches stale)
 *   cross-asset isolation, coalescing races -> market/market-isolation.test.ts,
 *                                   market/market.service.test.ts, services/analysis.concurrent-markets.test.ts
 *   provider mismatch (symbol/interval) -> market/market.provider.test.ts, failover.attribution.test.ts,
 *                                   failover.wrong-answer.test.ts
 *   HTTP security headers / CORS -> middleware/http-hardening.test.ts, middleware/cors.test.ts
 *   frozen-surface backward compatibility -> contract.test.ts, contract-semantics.test.ts
 *
 * What this file adds is the rest of the objective: the malformed `?interval=`
 * contract, hostile tickers, the non-finite wire guarantee (the schemas refuse
 * what `JSON.stringify` would silently nullify), and the candle data-quality
 * veto observed the way a client observes it - through the route.
 */

const { providerOverrides, providerFor, mockAnyProviderAvailable } = vi.hoisted(() => {
    const INTERVAL_MS: Record<string, number> = {
        '15m': 900_000,
        '1h': 3_600_000,
        '4h': 14_400_000,
        '1d': 86_400_000,
    };

    const overrides: { candles?: unknown[] | undefined } = { candles: undefined };

    const healthy = (interval: string, count = 900): unknown[] => {
        const spacing = INTERVAL_MS[interval] ?? (INTERVAL_MS['1h'] as number);
        const newest = Math.floor(Date.now() / spacing) * spacing;
        const start = newest - (count - 1) * spacing;

        return Array.from({ length: count }, (_unused, index) => {
            const close = 100 + index;

            return {
                timestamp: start + index * spacing,
                open: close,
                high: close + 2,
                low: close - 2,
                close,
                volume: 1000,
            };
        });
    };

    // One stub per (instrument, interval), echoing what it was asked for:
    // `fetchMarketData` refuses an answer named for another market or another
    // resolution, so a fixed-BTCUSDT stub would make every adversarial case
    // die as a setup error instead of the behaviour under test.
    const providerFor = (instrument: string, interval: string) => ({
        getPrice: vi.fn(async () => ({ symbol: instrument, price: 100 })),
        getCandles: vi.fn(async (limit = 900) =>
            (overrides.candles ?? healthy(interval, limit)) as never[],
        ),
        getAttributedCandles: vi.fn(async (limit?: number) => ({
            venue: 'binance',
            symbol: instrument,
            interval,
            candles: (overrides.candles ?? healthy(interval, limit ?? 900)) as never[],
        })),
        getAttributedPrice: vi.fn(async () => ({
            venue: 'binance',
            symbol: instrument,
            price: 100,
        })),
    });

    return {
        providerOverrides: overrides,
        providerFor,
        mockAnyProviderAvailable: vi.fn(() => true),
    };
});

vi.mock('../market/market.provider.js', () => ({
    marketProviderFor: (instrument: string, interval?: string) =>
        providerFor(instrument, interval ?? '1h'),
    marketDataProvider: providerFor('BTCUSDT', '1h'),
    anyMarketProviderAvailable: mockAnyProviderAvailable,
    activeMarketVenue: vi.fn(() => 'binance'),
    configuredMarketVenues: vi.fn(() => ['binance']),
    configuredVenueCapabilities: vi.fn(() => []),
}));

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { createApp } from '../app.js';
import { resetMarketDataCache } from '../market/market.service.js';
import { currentCandles } from '../test-support/candles.js';
import type { Candle } from '../types/market.js';
import {
    ApiErrorResponseSchema,
    CandleSchema,
    MarketAnalysisSchema,
    MarketResponseSchema,
} from './schemas.js';

const LEAK_MARKERS = ['stack', 'node_modules', '.ts:', '/src/'];

function expectNoLeak(raw: string): void {
    for (const marker of LEAK_MARKERS) {
        expect(raw.includes(marker), `leaked "${marker}"`).toBe(false);
    }
}

async function get(url: string) {
    const app = createApp();

    try {
        return await app.inject({ method: 'GET', url });
    } finally {
        await app.close();
    }
}

beforeEach(() => {
    providerOverrides.candles = undefined;
    resetMarketDataCache();
});

describe('the ?interval= contract', () => {
    it('refuses an interval it cannot compute with the stable 400 envelope', async () => {
        for (const raw of ['1W', 'abc', '1H', '4hh', '%00']) {
            const response = await get(
                `/api/instruments/BTCUSDT/market?interval=${raw}`,
            );

            expect(response.statusCode, `interval=${raw}`).toBe(400);

            const body = ApiErrorResponseSchema.parse(response.json());
            expect(body.error.code).toBe('INVALID_REQUEST');
            expectNoLeak(response.body);
        }
    });

    it('refuses a duplicated interval rather than guessing which one it meant', async () => {
        const response = await get(
            '/api/instruments/BTCUSDT/market?interval=1h&interval=4h',
        );

        expect(response.statusCode).toBe(400);
        expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(
            'INVALID_REQUEST',
        );
    });

    it('ignores parameters it does not know and honours the valid interval', async () => {
        const response = await get(
            '/api/instruments/BTCUSDT/market?interval=4h&foo=bar&callback=x',
        );

        expect(response.statusCode).toBe(200);

        const body = MarketResponseSchema.parse(response.json());
        expect(body.interval).toBe('4h');
        expectNoLeak(response.body);
    });

    it('means the configured interval when the query names none', async () => {
        const response = await get('/api/instruments/BTCUSDT/market');

        expect(response.statusCode).toBe(200);

        const body = MarketResponseSchema.parse(response.json());
        expect(body.interval).toBe('1h');
    });

    it('carries the requested resolution through the analysis route', async () => {
        const response = await get(
            '/api/instruments/BTCUSDT/analysis?interval=15m',
        );

        expect(response.statusCode).toBe(200);
        expect(
            (MarketAnalysisSchema.parse(response.json()) as { interval: string })
                .interval,
        ).toBe('15m');
        expectNoLeak(response.body);
    });
});

describe('hostile tickers', () => {
    it('normalises padding around the ticker like any other spelling', async () => {
        const response = await get('/api/instruments/%20btcusdt%20/market');

        expect(response.statusCode).toBe(200);

        const body = MarketResponseSchema.parse(response.json());
        expect(body.price.symbol).toBe('BTCUSDT');
        expect(body.instrument?.ticker).toBe('BTCUSDT');
    });

    it('answers hostile tickers without a 500, a stack, or an invalid envelope', async () => {
        const hostile = [
            '%00',
            '..%2Fetc%2Fpasswd',
            'BTCUSDT%401h',
            '%F0%9F%9A%80',
            'a'.repeat(300),
        ];

        for (const ticker of hostile) {
            const response = await get(`/api/instruments/${ticker}/market`);

            expect(response.statusCode, `ticker=${ticker}`).toBeLessThan(500);
            expectNoLeak(response.body);

            const parsed = response.json() as unknown;
            if (response.statusCode === 200) {
                expect(() => MarketResponseSchema.parse(parsed)).not.toThrow();
            } else {
                expect(() => ApiErrorResponseSchema.parse(parsed)).not.toThrow();
            }
        }
    });
});

describe('the data-quality veto, observed through the route', () => {
    it('vetoes a series containing Infinity before it becomes a response', async () => {
        const candles = currentCandles(900);
        const last = candles[candles.length - 1] as Candle;
        candles[candles.length - 1] = { ...last, close: Number.POSITIVE_INFINITY };
        providerOverrides.candles = candles;

        const response = await get('/api/instruments/BTCUSDT/market');

        expect(response.statusCode).toBe(502);
        expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(
            'MARKET_PROVIDER_ERROR',
        );
        expectNoLeak(response.body);
    });

    it('vetoes a series containing NaN the same way', async () => {
        const candles = currentCandles(900);
        const last = candles[candles.length - 1] as Candle;
        candles[candles.length - 1] = { ...last, close: Number.NaN };
        providerOverrides.candles = candles;

        const response = await get('/api/instruments/BTCUSDT/market');

        expect(response.statusCode).toBe(502);
        expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(
            'MARKET_PROVIDER_ERROR',
        );
    });

    it('refuses a duplicated bar at the route, not only in the unit', async () => {
        const candles = currentCandles(900);
        candles[candles.length - 1] = {
            ...(candles[candles.length - 2] as Candle),
        };
        providerOverrides.candles = candles;

        const response = await get('/api/instruments/BTCUSDT/market');

        expect(response.statusCode).toBe(502);
        expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(
            'MARKET_PROVIDER_ERROR',
        );
    });
});

describe('the non-finite wire guarantee', () => {
    it('refuses a non-finite number at the boundary instead of nullifying it', () => {
        expect(() =>
            MarketResponseSchema.parse({
                price: { symbol: 'BTCUSDT', price: Number.POSITIVE_INFINITY },
                candles: [],
                instrument: null,
                interval: '1h',
            }),
        ).toThrow();

        expect(() =>
            MarketResponseSchema.parse({
                price: { symbol: 'BTCUSDT', price: Number.NaN },
                candles: [],
                instrument: null,
                interval: '1h',
            }),
        ).toThrow();

        expect(() =>
            CandleSchema.parse({
                timestamp: Number.NaN,
                open: 1,
                high: 2,
                low: 0.5,
                close: 1,
                volume: 1,
            }),
        ).toThrow();

        expect(() =>
            CandleSchema.parse({
                timestamp: 1,
                open: 1,
                high: Number.POSITIVE_INFINITY,
                low: 0.5,
                close: 1,
                volume: 1,
            }),
        ).toThrow();
    });

    it('never lets a mutated indicator nullify on the wire', async () => {
        const response = await get('/api/instruments/BTCUSDT/analysis');

        expect(response.statusCode).toBe(200);

        const body = response.json() as {
            indicators: { ema300: number };
        };
        body.indicators.ema300 = Number.POSITIVE_INFINITY;

        expect(() => MarketAnalysisSchema.parse(body)).toThrow();
    });

    it('changes nothing for a payload a provider could really have sent', async () => {
        const market = await get('/api/instruments/BTCUSDT/market');
        const analysis = await get('/api/instruments/BTCUSDT/analysis');

        expect(market.statusCode).toBe(200);
        expect(analysis.statusCode).toBe(200);
        expect(() => MarketResponseSchema.parse(market.json())).not.toThrow();
        expect(() => MarketAnalysisSchema.parse(analysis.json())).not.toThrow();
    });
});
