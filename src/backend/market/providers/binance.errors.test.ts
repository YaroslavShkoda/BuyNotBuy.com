import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { BinanceProvider } from './binance.provider.js';
import { resetBinanceTransport } from './binance-http.js';
import { marketConfig } from '../../config/market.config.js';
import { MarketDataError } from '../../errors/market-data.error.js';

beforeEach(() => {
    // The breaker is process-wide state; a test that trips it would otherwise
    // silently turn every later test into an open-circuit refusal.
    resetBinanceTransport();
});

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

    it('maps HTTP 429 to MARKET_RATE_LIMITED with 503', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers(),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getCandles().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.code).toBe('MARKET_RATE_LIMITED');
        expect(error.statusCode).toBe(503);
    });

    it('treats HTTP 418 like a rate limit because it is an IP ban', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 418,
            headers: new Headers(),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.code).toBe('MARKET_RATE_LIMITED');
    });

    it('does not retry a rate limit: retrying is what earns the ban', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers({ 'Retry-After': '30' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const provider = new BinanceProvider();

        await provider.getPrice().catch(() => undefined);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('carries Retry-After and the used-weight header into the error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers({
                'Retry-After': '30',
                'X-MBX-USED-WEIGHT-1': '1200',
            }),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        // Without the weight reading it is impossible to tell a real throttle
        // from a request that merely happened to land near the limit.
        expect(error.retryAfterSeconds).toBe(30);
        expect(error.cause).toMatchObject({
            provider: 'binance',
            endpoint: '/api/v3/ticker/price',
            httpStatus: 429,
            retryAfterMs: 30000,
            usedWeight: '1200',
        });
    });

    it('caps an absurd Retry-After so a request can never hang for minutes', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers({ 'Retry-After': '86400' }),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.retryAfterSeconds).toBe(
            Math.round(marketConfig.maxRetryAfterMs / 1000),
        );
    });

    it('includes provider and endpoint context in HTTP 429 cause', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers(),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error.cause).toMatchObject({
            provider: 'binance',
            endpoint: '/api/v3/ticker/price',
            httpStatus: 429,
        });
    });

    it('reads the current weight header name as well as the legacy one', async () => {
        // Binance now answers with X-MBX-USED-WEIGHT; a reader pinned to the
        // old name would silently report "unknown" forever.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers({ 'X-MBX-USED-WEIGHT': '1180' }),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.cause).toMatchObject({ usedWeight: '1180' });
    });

    it('falls back to the rolling-minute weight when the window header is absent', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers({ 'X-MBX-USED-WEIGHT-1m': '640' }),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.cause).toMatchObject({ usedWeight: '640' });
    });

    it('reports no weight when the provider sends none', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers(),
        }));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.cause).toMatchObject({ usedWeight: null });
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

    it('keeps originalError string in timeout cause for internal diagnostics', async () => {
        const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

        const provider = new BinanceProvider();

        const error = await provider.getPrice().catch((e) => e);

        expect(error.cause).toMatchObject({
            provider: 'binance',
            endpoint: '/api/v3/ticker/price',
            timeoutMs: marketConfig.requestTimeoutMs,
            originalError: 'TimeoutError: The operation timed out',
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
