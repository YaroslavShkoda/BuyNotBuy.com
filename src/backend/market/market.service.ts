import { 
    getBitcoinPrice, 
    getBitcoinCandles, 
} from "./binance.client";

import type { MarketData } from "../types/market";

export async function getMarketData(): Promise<MarketData> {
    const [price, candles] = await Promise.all([
        getBitcoinPrice(),
        getBitcoinCandles(),
    ]);

    return {
        price,
        candles,
    };
}