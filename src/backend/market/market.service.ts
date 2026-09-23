import { marketDataProvider } from './market.provider';

import { marketConfig } from '../config/market.config';
import { MarketDataError } from '../errors/market-data.error';

import type { AssetPrice, MarketData } from '../types/market';

let inFlightMarketData: Promise<MarketData> | null = null;

export async function getPrice(): Promise<AssetPrice> {
    return marketDataProvider.getPrice();
}

export async function getMarketData(): Promise<MarketData> {
    if (inFlightMarketData !== null) {
        return inFlightMarketData;
    }

    const task = loadMarketData();

    inFlightMarketData = task;

    try {
        return await task;
    } finally {
        inFlightMarketData = null;
    }
}

async function loadMarketData(): Promise<MarketData> {
    const [price, candles] = await Promise.all([
        marketDataProvider.getPrice(),
        marketDataProvider.getCandles(),
    ]);

    if (candles.length === 0) {
        throw new MarketDataError(
            'Market data provider returned no candles',
            {
                code: 'MARKET_PROVIDER_ERROR',
                cause: {
                    provider: marketConfig.provider,
                    endpoint: '/api/v3/klines',
                    candleCount: 0,
                },
            },
        );
    }

    return {
        price,
        candles,
    };
}
