import { marketConfig } from '../config/market.config';

import { BinanceProvider } from './providers/binance.provider';
import { MockProvider } from './providers/mock.provider';

import type { MarketDataProvider } from './providers/market-data.provider';

function createMarketDataProvider(): MarketDataProvider {
    switch (marketConfig.provider) {
        case 'binance':
            return new BinanceProvider();

        case 'mock':
            return new MockProvider();

        default:
            throw new Error(
                `Unsupported market data provider: ${marketConfig.provider}`,
            );
    }
}

export const marketDataProvider =
    createMarketDataProvider();
