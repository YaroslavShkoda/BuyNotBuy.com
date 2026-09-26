import { marketConfig } from '../config/market.config.js';

import { BinanceProvider } from './providers/binance.provider.js';
import { BitgetProvider } from './providers/bitget.provider.js';
import { MockProvider } from './providers/mock.provider.js';
import { FailoverProvider } from './failover.provider.js';

import type { MarketProviderName } from '../config/market.config.js';
import type { MarketDataProvider } from './providers/market-data.provider.js';

/**
 * Builds one venue.
 *
 * Each is given the base URL and ticker that venue was configured with. The
 * backup does not inherit the primary's address — a deployment that cannot
 * reach one venue is exactly the deployment for which the other address is the
 * value, and inheriting it would defeat the setting.
 */
function createVenue(name: MarketProviderName): {
    name: string;
    provider: MarketDataProvider;
} {
    switch (name) {
        case 'binance':
            return {
                name,
                provider: new BinanceProvider(),
            };

        case 'bitget':
            return {
                name,
                provider: new BitgetProvider({
                    baseUrl: marketConfig.fallbackBaseUrl,
                    symbol: marketConfig.fallbackSymbol,
                }),
            };

        case 'mock':
            return {
                name,
                provider: new MockProvider(),
            };

        default:
            throw new Error(
                `Unsupported market data provider: ${name}`,
            );
    }
}

function createMarketDataProvider(): MarketDataProvider {
    const primary = createVenue(marketConfig.provider);

    if (marketConfig.fallbackProviders.length === 0) {
        return primary.provider;
    }

    const backups = marketConfig.fallbackProviders.map((name) => createVenue(name));

    return new FailoverProvider(primary, backups);
}

export const marketDataProvider =
    createMarketDataProvider();
