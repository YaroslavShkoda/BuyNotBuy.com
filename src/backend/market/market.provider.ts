import { BinanceProvider } from './providers/binance.provider';

import type { MarketDataProvider } from './providers/market-data.provider';

export const marketDataProvider: MarketDataProvider = new BinanceProvider();