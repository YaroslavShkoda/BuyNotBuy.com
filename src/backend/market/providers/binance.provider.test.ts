import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { BinanceProvider } from './binance.provider';
import { MarketDataError } from '../../errors/market-data.error';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('BinanceProvider', () => {
    describe('getBitcoinPrice', () => {
        it('returns Bitcoin price from Binance API', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    symbol: 'BTCUSDT',
                    price: '81246.50',
                }),
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const result = await provider.getBitcoinPrice();

            expect(result).toEqual({
                symbol: 'BTCUSDT',
                price: 81246.5,
            });

            expect(fetchMock).toHaveBeenCalledOnce();
            expect(fetchMock).toHaveBeenCalledWith(
                'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',
            );
        });

        it('throws MarketDataError when Binance returns an HTTP error', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getBitcoinPrice(),
            ).rejects.toThrow(
                new MarketDataError('Binance API error: 503'),
            );
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
                provider.getBitcoinPrice(),
            ).rejects.toThrow();
        });
    });

    describe('getBitcoinCandles', () => {
        it('returns Bitcoin candles from Binance API', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    [
                        1700000000000,
                        '80000.00',
                        '81000.00',
                        '79000.00',
                        '80500.00',
                        '123.45',
                    ],
                    [
                        1700003600000,
                        '80500.00',
                        '82000.00',
                        '80000.00',
                        '81500.00',
                        '150.25',
                    ],
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            const result = await provider.getBitcoinCandles(2);

            expect(result).toEqual([
                {
                    timestamp: 1700000000000,
                    open: 80000,
                    high: 81000,
                    low: 79000,
                    close: 80500,
                    volume: 123.45,
                },
                {
                    timestamp: 1700003600000,
                    open: 80500,
                    high: 82000,
                    low: 80000,
                    close: 81500,
                    volume: 150.25,
                },
            ]);

            expect(fetchMock).toHaveBeenCalledOnce();
            expect(fetchMock).toHaveBeenCalledWith(
                'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2',
            );
        });

        it('throws MarketDataError when Binance returns an HTTP error', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getBitcoinCandles(),
            ).rejects.toThrow(
                new MarketDataError('Binance API error: 503'),
            );
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
                provider.getBitcoinCandles(),
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
                    ],
                ],
            });

            vi.stubGlobal('fetch', fetchMock);

            const provider = new BinanceProvider();

            await expect(
                provider.getBitcoinCandles(),
            ).rejects.toThrow();
        });
    });
});
