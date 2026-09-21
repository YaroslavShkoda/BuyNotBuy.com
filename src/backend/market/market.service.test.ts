import { describe, expect, it, vi } from 'vitest';

const { mockMarketDataProvider } = vi.hoisted(() => ({
    mockMarketDataProvider: {
        getPrice: vi.fn(),
        getCandles: vi.fn(),
    },
}));

vi.mock('./market.provider', () => ({
    marketDataProvider: mockMarketDataProvider,
}));

import { getMarketData } from './market.service';

describe('market.service', () => {
    it('returns market data from the provider', async () => {
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
});
