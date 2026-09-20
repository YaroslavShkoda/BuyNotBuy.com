import { describe, expect, it } from 'vitest';
import { calculateMarketIndicators } from './indicator.service';
import type { MarketData } from '../types/market';

describe('calculateMarketIndicators', () => {
    it('calculates EMA 300 and Stochastic 100', () => {
        const candles = Array.from({ length: 300 }, (_, index) => {
                const close = 100 + index;

                return {
                    timestamp: index,
                    open: close - 1,
                    high: close + 2,
                    low: close - 2,
                    close,
                    volume: 1000,
                };
            },
        );

        const marketData: MarketData = {
            price: {
                symbol: 'BTCUSDT',
                price: 400,
            },
            candles,
        };

        const result = calculateMarketIndicators(marketData);

        expect(result).toHaveProperty('ema300');
        expect(result).toHaveProperty('stochastic');

        expect(result.ema300).toBeCloseTo(249.5);
        expect(result.stochastic).toBeGreaterThanOrEqual(0);
        expect(result.stochastic).toBeLessThanOrEqual(100);
    });

    it('throws when there are fewer than 300 candles', () => {
        const candles = Array.from({ length: 299 }, (_, index) => {
                const close = 100 + index;

                return {
                    timestamp: index,
                    open: close - 1,
                    high: close + 2,
                    low: close - 2,
                    close,
                    volume: 1000,
                };
            },
        );
        
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