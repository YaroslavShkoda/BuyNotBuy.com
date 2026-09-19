import type { MarketData } from "../types/market";
import { calculateEMA } from "./ema";

const EMA_PERIOD = 300;

export interface MarketIndicators {
    ema300: number;
}

export function calculateMarketIndicators(
    marketData: MarketData,
): MarketIndicators {
    const closePrices = marketData.candles.map(
        (candle) => candle.close,
    );

    const ema300 = calculateEMA(
        closePrices,
        EMA_PERIOD,
    );

    return {
        ema300,
    };
}