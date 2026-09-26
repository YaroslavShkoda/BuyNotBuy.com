import { marketConfig } from '../config/market.config.js';

import { BinanceProvider } from './providers/binance.provider.js';
import { MockProvider } from './providers/mock.provider.js';

import type { MarketDataProvider } from './providers/market-data.provider.js';

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
