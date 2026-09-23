import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketDataError } from '../errors/market-data.error';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(),
        getCandles: vi.fn(),
    },
}));

vi.mock('./market.provider', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

import { getMarketData, getPrice } from './market.service';

describe('market.service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('getPrice() delegates to provider.getPrice() without loading candles', async () => {
        const price = {
            symbol: 'BTCUSDT',
            price: 81246.5,
        };

        mockMarketDataProvider.getPrice.mockResolvedValueOnce(price);

        const result = await getPrice();

        expect(result).toEqual(price);

        expect(mockMarketDataProvider.getPrice).toHaveBeenCalledTimes(1);
        expect(mockMarketDataProvider.getCandles).not.toHaveBeenCalled();
    });

    it('getMarketData() returns price + candles from the provider', async () => {
        const price = {
            symbol: 'BTCUSDT',
            price: 80000,
        };

        const candles = [
            {
                timestamp: 1,
                open: 79000,
                high: 81000,
                low: 78000,
                close: 80000,
                volume: 100,
            },
        ];

        mockMarketDataProvider.getPrice.mockResolvedValueOnce(price);
        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        const result = await getMarketData();

        expect(result).toEqual({
            price,
            candles,
        });

        expect(mockMarketDataProvider.getPrice).toHaveBeenCalledTimes(1);
        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
    });

    it('getMarketData() deduplicates concurrent calls into one provider request', async () => {
        const price = {
            symbol: 'BTCUSDT',
            price: 80000,
        };

        const candles = [
            {
                timestamp: 1,
                open: 79000,
                high: 81000,
                low: 78000,
                close: 80000,
                volume: 100,
            },
        ];

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        mockMarketDataProvider.getPrice.mockImplementationOnce(async () => {
            await gate;
            return price;
        });
        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        const first = getMarketData();
        const second = getMarketData();

        release();

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toEqual({ price, candles });
        expect(secondResult).toEqual({ price, candles });

        expect(mockMarketDataProvider.getPrice).toHaveBeenCalledTimes(1);
        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(1);
    });

    it('getMarketData() does not share a failed request with the next call', async () => {
        const price = {
            symbol: 'BTCUSDT',
            price: 80000,
        };

        const candles = [
            {
                timestamp: 1,
                open: 79000,
                high: 81000,
                low: 78000,
                close: 80000,
                volume: 100,
            },
        ];

        mockMarketDataProvider.getPrice.mockRejectedValueOnce(
            new MarketDataError('upstream failed'),
        );
        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        await expect(getMarketData()).rejects.toBeInstanceOf(MarketDataError);

        mockMarketDataProvider.getPrice.mockResolvedValueOnce(price);
        mockMarketDataProvider.getCandles.mockResolvedValueOnce(candles);

        const result = await getMarketData();

        expect(result).toEqual({ price, candles });
        expect(mockMarketDataProvider.getPrice).toHaveBeenCalledTimes(2);
        expect(mockMarketDataProvider.getCandles).toHaveBeenCalledTimes(2);
    });

    it('getMarketData() rejects empty candles with a normalized error', async () => {
        mockMarketDataProvider.getPrice.mockResolvedValueOnce({
            symbol: 'BTCUSDT',
            price: 80000,
        });
        mockMarketDataProvider.getCandles.mockResolvedValueOnce([]);

        const error = await getMarketData().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MarketDataError);
        expect(error).toMatchObject({
            name: 'MarketDataError',
            code: 'MARKET_PROVIDER_ERROR',
            statusCode: 502,
        });
    });
});
