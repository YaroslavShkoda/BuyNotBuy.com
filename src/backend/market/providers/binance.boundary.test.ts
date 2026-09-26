import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BinanceProvider } from './binance.provider.js';
import { resetBinanceTransport } from './binance-http.js';
import { MAX_CANDLE_LIMIT } from '../../config/market.config.js';
import { MarketDataError } from '../../errors/market-data.error.js';

function okWith(body: unknown) {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body,
    };
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): string {
    return String(fetchMock.mock.calls[0]?.[0]);
}

beforeEach(() => {
    resetBinanceTransport();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('BinanceProvider numeric boundary', () => {
    it('reads an empty string as zero, the documented Binance placeholder', async () => {
        // Binance leaves trailing fields blank on the still-forming bar. A
        // blank close that became NaN would break every indicator, and one
        // that became a real price would quietly corrupt the series.
        const fetchMock = vi.fn().mockResolvedValue(okWith({
            symbol: 'BTCUSDT',
            price: '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await new BinanceProvider().getPrice();

        expect(result.price).toBe(0);
    });

    it('still rejects a price that is merely close to a number', async () => {
        const fetchMock = vi.fn().mockResolvedValue(okWith({
            symbol: 'BTCUSDT',
            price: '81246.50 USDT',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const error = await new BinanceProvider().getPrice().catch((e) => e);

        // A lenient parse would hand a string-derived NaN to the chart.
        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_PROVIDER_ERROR');
    });

    it('rejects a partially numeric price', async () => {
        const fetchMock = vi.fn().mockResolvedValue(okWith({
            symbol: 'BTCUSDT',
            price: '81246.50abc',
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(new BinanceProvider().getPrice()).rejects.toBeInstanceOf(
            MarketDataError,
        );
    });

    it('rejects a negative price', async () => {
        const fetchMock = vi.fn().mockResolvedValue(okWith({
            symbol: 'BTCUSDT',
            price: '-1',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const error = await new BinanceProvider().getPrice().catch((e) => e);

        expect(error.code).toBe('MARKET_PROVIDER_ERROR');
    });

    it('rejects a negative candle volume', async () => {
        const now = Date.now();

        const fetchMock = vi.fn().mockResolvedValue(okWith([
            [now - 7_200_000, '1', '2', '0.5', '1.5', '-1', now - 3_600_000, '1500'],
        ]));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            new BinanceProvider().getCandles(1),
        ).rejects.toBeInstanceOf(MarketDataError);
    });

    it('rejects a candle series larger than the provider could ever return', async () => {
        const oversized = Array.from(
            { length: MAX_CANDLE_LIMIT + 1 },
            (_, index) => [index, '1', '2', '0.5', '1.5', '1', index + 1, '1500'],
        );

        const fetchMock = vi.fn().mockResolvedValue(okWith(oversized));
        vi.stubGlobal('fetch', fetchMock);

        const error = await new BinanceProvider()
            .getCandles(MAX_CANDLE_LIMIT)
            .catch((e: unknown) => e as Error & { code?: string });

        // Materialising an unbounded array first would let a bad upstream
        // exhaust memory before anything could object.
        expect(error).toBeInstanceOf(MarketDataError);
        expect((error as MarketDataError).code).toBe('MARKET_PROVIDER_ERROR');
    });

    it('accepts a series exactly at the cap', async () => {
        const now = Date.now();
        const atCap = Array.from({ length: MAX_CANDLE_LIMIT }, (_, index) => [
            now - (MAX_CANDLE_LIMIT - index) * 3_600_000,
            '1',
            '2',
            '0.5',
            '1.5',
            '1',
            now - (MAX_CANDLE_LIMIT - index) * 3_600_000 + 3_599_999,
            '1500',
        ]);

        const fetchMock = vi.fn().mockResolvedValue(okWith(atCap));
        vi.stubGlobal('fetch', fetchMock);

        const result = await new BinanceProvider().getCandles(MAX_CANDLE_LIMIT);

        expect(result).toHaveLength(MAX_CANDLE_LIMIT);
    });
});

describe('BinanceProvider request construction', () => {
    it('encodes the symbol and interval in the query string', async () => {
        const fetchMock = vi.fn().mockResolvedValue(okWith([]));
        vi.stubGlobal('fetch', fetchMock);

        await new BinanceProvider().getCandles(10);

        const url = lastUrl(fetchMock);

        // A symbol or interval carrying a separator would otherwise be able to
        // inject extra query parameters into the upstream request.
        const rawQuery = url.slice(url.indexOf('?') + 1);

        expect(rawQuery.split('&')).toHaveLength(3);

        const parsed = new URL(url);

        expect([...parsed.searchParams.keys()]).toEqual([
            'symbol',
            'interval',
            'limit',
        ]);
        expect(parsed.searchParams.get('symbol')).toBe('BTCUSDT');
        expect(parsed.searchParams.get('interval')).toBe('1h');
        expect(parsed.searchParams.get('limit')).toBe('10');
    });

    it('encodes the price endpoint symbol as well', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            okWith({ symbol: 'BTCUSDT', price: '1' }),
        );
        vi.stubGlobal('fetch', fetchMock);

        await new BinanceProvider().getPrice();

        expect(lastUrl(fetchMock)).toContain('/api/v3/ticker/price?symbol=');
    });
});
