import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { BinanceProvider } from './binance.provider.js';
import { MarketDataError } from '../../errors/market-data.error.js';
import { requiredCandleCount } from '../../config/indicator.config.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('BinanceProvider', () => {
    describe('getPrice', () => {
        it('returns market price from Binance API', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    symbol: 'BTCUSDT',
                    price: '81246.50',
                }),
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const result = await provider.getPrice();

            expect(result).toEqual({
                symbol: 'BTCUSDT',
                price: 81246.5,
            });

            expect(fetchMock).toHaveBeenCalledOnce();

            const [url, options] = fetchMock.mock.calls[0] ?? [];

            expect(url).toBe(
                'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',
            );

            expect(options?.signal).toBeInstanceOf(AbortSignal);
        });

        it('throws MarketDataError when Binance returns an HTTP error', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getPrice(),
            ).rejects.toMatchObject({
                name: 'MarketDataError',
                code: 'MARKET_DATA_UNAVAILABLE',
                statusCode: 503,
            });
        });

        it('throws when Binance returns invalid data', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    symbol: 'BTCUSDT',
                    price: 'INVALID',
                }),
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getPrice(),
            ).rejects.toThrow();
        });

        it('throws MarketDataError when fetch fails', async () => {
            const fetchMock = vi.fn().mockRejectedValue(
                new Error('Network error'),
            );

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getPrice(),
            ).rejects.toThrow(
                new MarketDataError(
                    'Failed to fetch market price from Binance',
                ),
            );
        });

        it('throws MarketDataError when response JSON parsing fails', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: vi.fn().mockRejectedValue(
                    new Error('Invalid JSON'),
                ),
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getPrice(),
            ).rejects.toThrow(
                new MarketDataError(
                    'Failed to fetch market price from Binance',
                ),
            );
        });
    });

    describe('getCandles', () => {
        const CLOSED_1 = 1700003599999;
        const CLOSED_2 = 1700007199999;

        /**
         * A real `/api/v3/klines` row: openTime, open, high, low, close, base
         * volume, closeTime, quote volume, trades, two taker-buy figures and an
         * unused field.
         *
         * Built here rather than written as a literal so the two volume
         * positions cannot be confused again. The base and notional figures are
         * deliberately different numbers, because a fixture that made them equal
         * would pass whichever of the two the provider read.
         */
        function kline({
            openTime,
            closeTime,
            open = '80000.00',
            high = '81000.00',
            low = '79000.00',
            close = '80500.00',
            baseVolume = '123.45',
            quoteVolume = '10371100.00',
        }: {
            openTime: number;
            closeTime: number;
            open?: string;
            high?: string;
            low?: string;
            close?: string;
            baseVolume?: string;
            quoteVolume?: string;
        }) {
            return [
                openTime,
                open,
                high,
                low,
                close,
                baseVolume,
                closeTime,
                quoteVolume,
                '31817',
                '60.00',
                '5000000.00',
                '0',
            ];
        }

        it('uses configured symbol, interval, and default limit', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await provider.getCandles();

            expect(fetchMock).toHaveBeenCalledOnce();

            const [url] = fetchMock.mock.calls[0] ?? [];

            expect(url).toBe(
                'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=900',
            );
        });

        it('returns market candles from Binance API', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    kline({
                        openTime: 1700000000000,
                        closeTime: CLOSED_1,
                        baseVolume: '123.45',
                        quoteVolume: '10371100.00',
                    }),
                    kline({
                        openTime: 1700003600000,
                        closeTime: CLOSED_2,
                        open: '80500.00',
                        high: '82000.00',
                        low: '80000.00',
                        close: '81500.00',
                        baseVolume: '150.25',
                        quoteVolume: '12953100.00',
                    }),
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const result = await provider.getCandles(2);

            expect(result).toEqual([
                {
                    timestamp: 1700000000000,
                    open: 80000,
                    high: 81000,
                    low: 79000,
                    close: 80500,
                    // The notional figure, not the 123.45 BTC base one.
                    volume: 10371100,
                },
                {
                    timestamp: 1700003600000,
                    open: 80500,
                    high: 82000,
                    low: 80000,
                    close: 81500,
                    volume: 12953100,
                },
            ]);

            expect(fetchMock).toHaveBeenCalledOnce();

            const [url, options] = fetchMock.mock.calls[0] ?? [];

            expect(url).toBe(
                'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2',
            );

            expect(options?.signal).toBeInstanceOf(AbortSignal);
        });

        it('drops the still-forming candle so one URL yields one signal', async () => {
            const now = Date.now();
            const hourMs = 60 * 60 * 1000;
            const openTime = now - hourMs;

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    kline({ openTime: openTime - hourMs, closeTime: openTime - 1 }),
                    kline({ openTime, closeTime: now + 60_000, close: '81000.00' }),
                ],
            }));

            const provider = new BinanceProvider();

            const result = await provider.getCandles(2);

            // The last element of every Binance klines response is the hour
            // that is still running. Feeding it to the indicators made the
            // signal change several times within a single candle.
            expect(result).toHaveLength(1);
            expect(result[0]?.timestamp).toBe(openTime - hourMs);
            expect(result[0]?.close).toBe(80500);
        });

        it('yields exactly the warm-up count when asked for one bar more', async () => {
            const now = Date.now();
            const hourMs = 60 * 60 * 1000;
            const oldest = now - (requiredCandleCount() + 1) * hourMs;

            const rows = Array.from(
                { length: requiredCandleCount() + 1 },
                (_, index) => {
                    const openTime = oldest + index * hourMs;
                    const isLast = index === requiredCandleCount();

                    return kline({
                        openTime,
                        // Everything but the final bar has closed.
                        closeTime: isLast ? now + 60_000 : openTime + hourMs - 1,
                    });
                },
            );

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => rows,
            }));

            const provider = new BinanceProvider();

            const result = await provider.getCandles(
                requiredCandleCount() + 1,
            );

            // This is the contract the market layer depends on: one extra
            // requested bar absorbs the one still forming, so the indicator
            // warm-up receives the full window instead of coming up short.
            expect(result).toHaveLength(requiredCandleCount());
        });

        it('returns an empty list when the whole response is still forming', async () => {
            const now = Date.now();

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [kline({ openTime: now, closeTime: now + 3_600_000 })],
            }));

            const provider = new BinanceProvider();

            await expect(provider.getCandles(2)).resolves.toEqual([]);
        });

        it('rejects a candle without a close time instead of guessing', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    [1700000000000, '80000.00', '81000.00', '79000.00', '80500.00', '123.45'],
                ],
            }));

            const provider = new BinanceProvider();

            const error = await provider.getCandles(1).catch((e: unknown) => e);

            // Without closeTime there is no way to tell a closed candle from
            // the running one, so the boundary refuses the response.
            expect(error).toBeInstanceOf(MarketDataError);
            expect((error as MarketDataError).code).toBe('MARKET_PROVIDER_ERROR');
        });

        it('accepts live Binance klines with trailing fields', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    kline({
                        openTime: 1700000000000,
                        closeTime: 1700003599999,
                        baseVolume: '123.45',
                        quoteVolume: '999999.00',
                    }),
                    kline({
                        openTime: 1700003600000,
                        closeTime: 1700007199999,
                        open: '80500.00',
                        high: '82000.00',
                        low: '80000.00',
                        close: '81500.00',
                        baseVolume: '150.25',
                        quoteVolume: '888888.00',
                    }),
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const result = await provider.getCandles(2);

            expect(result).toEqual([
                {
                    timestamp: 1700000000000,
                    open: 80000,
                    high: 81000,
                    low: 79000,
                    close: 80500,
                    volume: 999999,
                },
                {
                    timestamp: 1700003600000,
                    open: 80500,
                    high: 82000,
                    low: 80000,
                    close: 81500,
                    volume: 888888,
                },
            ]);
        });

        it('preserves Binance chronological ordering', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    kline({ openTime: 1700000000000, closeTime: CLOSED_1 }),
                    kline({
                        openTime: 1700003600000,
                        closeTime: CLOSED_2,
                        open: '80500.00',
                        high: '82000.00',
                        low: '80000.00',
                        close: '81500.00',
                    }),
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const result = await provider.getCandles(2);

            expect(result[0]?.timestamp).toBe(1700000000000);
            expect(result[1]?.timestamp).toBe(1700003600000);
            expect(result[1]?.timestamp).toBeGreaterThan(result[0]?.timestamp ?? 0);
        });

        it('rejects NaN and Infinity candle values', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    [1700000000000, '80000.00', 'Infinity', '79000.00', '80500.00', '123.45', CLOSED_1],
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const error = await provider.getCandles().catch((e) => e);

            expect(error).toBeInstanceOf(MarketDataError);
            expect(error.code).toBe('MARKET_PROVIDER_ERROR');
        });

        it('throws MarketDataError when Binance returns an HTTP error', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getCandles(),
            ).rejects.toMatchObject({
                name: 'MarketDataError',
                code: 'MARKET_DATA_UNAVAILABLE',
                statusCode: 503,
            });
        });

        it('throws when Binance returns invalid candle data', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    [
                        1700000000000,
                        '80000.00',
                    ],
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getCandles(),
            ).rejects.toThrow();
        });

        it('throws when Binance returns a non-numeric candle value', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    [
                        1700000000000,
                        '80000.00',
                        'INVALID',
                        '79000.00',
                        '80500.00',
                        '123.45',
                        CLOSED_1,
                    ],
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getCandles(),
            ).rejects.toThrow();
        });

        it('throws MarketDataError when fetch fails', async () => {
            const fetchMock = vi.fn().mockRejectedValue(
                new Error('Network error'),
            );

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getCandles(),
            ).rejects.toThrow(
                new MarketDataError(
                    'Failed to fetch market candles from Binance',
                ),
            );
        });

        it('throws MarketDataError when response JSON parsing fails', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: vi.fn().mockRejectedValue(
                    new Error('Invalid JSON'),
                ),
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getCandles(),
            ).rejects.toThrow(
                new MarketDataError(
                    'Failed to fetch market candles from Binance',
                ),
            );
        });
    });
});
