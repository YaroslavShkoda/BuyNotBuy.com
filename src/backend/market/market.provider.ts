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

/**
 * The venue currently answering, or null when there is nothing to switch.
 *
 * Null rather than a name when failover is off, so a caller cannot report a
 * "venue" that was never a choice.
 */
export function activeMarketVenue(): string | null {
    return marketDataProvider instanceof FailoverProvider
        ? marketDataProvider.activeVenue
        : null;
}

export interface VenueWatcherLogger {
    warn(context: Record<string, unknown>, message: string): void;
    info?(context: Record<string, unknown>, message: string): void;
}

/**
 * Reports a venue change, once, the next time it is called.
 *
 * The switch is otherwise silent, and silent is the wrong property for it. The
 * two venues do not print the same price, so a service quietly running on the
 * backup looks like a market move in every metric and every chart. An operator
 * has to be able to tell "the price changed" from "we stopped asking".
 *
 * It is a poll rather than a callback because the provider is built at import
 * time, long before the logger exists, and the poller is deliberately ignorant
 * of which venues exist.
 */
export function createVenueWatcher(
    logger: VenueWatcherLogger,
    currentVenue: () => string | null = activeMarketVenue,
    configuredPrimary: string = marketConfig.provider,
): () => void {
    let last: string | null | undefined;

    return () => {
        const venue = currentVenue();

        if (venue === last) {
            return;
        }

        const from = last;

        last = venue;

        // The first observation is the process starting, not a failover, and
        // logging it as one would cry wolf on every restart. The configured
        // primary is in the line anyway, because a service that boots while the
        // primary is already unreachable starts life on the backup and an
        // operator at 3am needs to be told which venue was skipped.
        if (from === undefined) {
            if (venue !== null) {
                logger.info?.(
                    {
                        event: 'market_venue_active',
                        venue,
                        primary: configuredPrimary,
                        onBackup: venue !== configuredPrimary,
                    },
                    'market_venue_active',
                );
            }

            return;
        }

        if (venue === null) {
            return;
        }

        logger.warn(
            { event: 'market_venue_switched', from, to: venue },
            'market_venue_switched',
        );
    };
}
