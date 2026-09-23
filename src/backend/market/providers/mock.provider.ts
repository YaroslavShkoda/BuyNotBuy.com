import { marketConfig } from '../../config/market.config';

import type {
    AssetPrice,
    Candle,
} from '../../types/market';

import type { MarketDataProvider } from './market-data.provider';

export class MockProvider implements MarketDataProvider {
    async getPrice(): Promise<AssetPrice> {
        return {
            symbol: marketConfig.symbol,
            price: 100000,
        };
    }

    async getCandles(
        limit: number = marketConfig.defaultCandleLimit,
    ): Promise<Candle[]> {
        const candles: Candle[] = [];

        const startTimestamp = 1_700_000_000_000;
        const intervalMs = 60 * 60 * 1000;

        for (let i = 0; i < limit; i += 1) {
            const close = 100000 + i;

            candles.push({
                timestamp: startTimestamp + i * intervalMs,
                open: close - 10,
                high: close + 10,
                low: close - 20,
                close,
                volume: 1000,
            });
        }

        return candles;
    }
}
