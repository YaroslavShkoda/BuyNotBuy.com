import { describe, expect, it } from "vitest";
import { calculateMarketIndicators } from "./indicator.service";
import type { MarketData } from "../types/market";

describe('calculateMarketIndicators', () => {
    it('calculates EMA 300 from candle close prices', () => {
        const candles = Array.from({ length: 300 }, (_, index) => ({
            timestamp: index, 
            open: 100,
            high: 100,
            low: 100,
            close: 100 + index,
            volume: 1000,
        }));

        const marketData: MarketData = {
            price: {
                symbol: 'BTCUSDT',
                price: 400,
            },
            candles,
        };

        const result = calculateMarketIndicators(marketData);

        expect(result).toHaveProperty('ema300');
        expect(result.ema300).toBeCloseTo(249.5);
    });

    it('throws when there are fewer than 300 candles', () => {
        const candles = Array.from({ length: 299 }, (_, index) => ({
            timestamp: index,
            open: 100,
            high: 100,
            low: 100,
            close: 100 + index,
            volume: 1000,
        }));

        const marketData: MarketData = {
            price: {
                symbol: 'BTCUSDT',
                price: 400,
            },
            candles,
        };

        expect(() => calculateMarketIndicators(marketData)).toThrow(
            'EMA requires at least 300 values',
        );
    });
});