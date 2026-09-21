import { marketConfig } from '../config/market.config';

import { BinanceProvider } from './providers/binance.provider';

import type { MarketDataProvider } from './providers/market-data.provider';

function createMarketDataProvider(): MarketDataProvider {
    switch (marketConfig.provider) {
        case 'binance':
            return new BinanceProvider();

        default:
            throw new Error(
                `Unsupported market data provider: ${marketConfig.provider}`,
            );
    }
}

export const marketDataProvider =
    createMarketDataProvider();
