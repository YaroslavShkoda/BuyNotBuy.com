import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { BinanceProvider } from './binance.provider';
import { marketConfig } from '../../config/market.config';
import { MarketDataError } from '../../errors/market-data.error';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('BinanceProvider error cases', () => {
    it('maps HTTP 500 to MARKET_DATA_UNAVAILABLE with 503', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(error.statusCode).toBe(503);
        expect(error.cause).toMatchObject({
            provider: 'binance',
            endpoint: '/api/v3/ticker/price',
            httpStatus: 500,
        });
    });

    it('maps HTTP 429 to MARKET_DATA_UNAVAILABLE with 503', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
        }));

        const provider = new BinanceProvider();

        const error = await provider.getCandles().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(error.statusCode).toBe(503);
    });

    it('maps HTTP 400 to MARKET_PROVIDER_ERROR with 502', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_PROVIDER_ERROR');
        expect(error.statusCode).toBe(502);
    });

    it('maps timeout to MARKET_PROVIDER_TIMEOUT with 504', async () => {
        const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_PROVIDER_TIMEOUT');
        expect(error.statusCode).toBe(504);
    });

    it('maps candles timeout to MARKET_PROVIDER_TIMEOUT with 504', async () => {
        const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

        const provider = new BinanceProvider();

        const error = await provider.getCandles().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_PROVIDER_TIMEOUT');
        expect(error.statusCode).toBe(504);
        expect(error.cause).toMatchObject({
            provider: 'binance',
            endpoint: '/api/v3/klines',
            timeoutMs: marketConfig.requestTimeoutMs,
        });
    });

    it('includes configured timeoutMs in price timeout cause', async () => {
        const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.cause).toMatchObject({
            provider: 'binance',
            endpoint: '/api/v3/ticker/price',
            timeoutMs: marketConfig.requestTimeoutMs,
        });
    });

    it('passes configured requestTimeoutMs to AbortSignal.timeout for both endpoints', async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ symbol: 'BTCUSDT', price: '81246.50' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const provider = new BinanceProvider();

        await provider.getPrice();

        expect(timeoutSpy).toHaveBeenCalledWith(marketConfig.requestTimeoutMs);

        timeoutSpy.mockClear();
        fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

        await provider.getCandles();

        expect(timeoutSpy).toHaveBeenCalledWith(marketConfig.requestTimeoutMs);
    });

    it('maps malformed JSON to MARKET_DATA_UNAVAILABLE and keeps cause', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getCandles().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(error.cause).toMatchObject({ provider: 'binance' });
    });

    it('maps invalid response schema (ZodError) to MARKET_PROVIDER_ERROR', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ symbol: 'BTCUSDT', price: 'INVALID' }),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_PROVIDER_ERROR');
        expect(error.statusCode).toBe(502);
    });

    it('maps network error to MARKET_DATA_UNAVAILABLE and keeps cause', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_DATA_UNAVAILABLE');
        expect(error.cause).toMatchObject({ provider: 'binance' });
    });
});
