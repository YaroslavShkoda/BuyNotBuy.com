import { 
    getBitcoinPrice, 
    getBitcoinCandles, 
} from "./binance.client";

import type { MarketData } from "../types/market";

const CANDLE_LIMIT = 500;

export async function getMarketData(): Promise<MarketData> {
    const [price, candles] = await Promise.all([
        getBitcoinPrice(),
        getBitcoinCandles(CANDLE_LIMIT),
    ]);

    return {
        price,
        candles,
    };
}