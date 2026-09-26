import { describe, expect, it } from 'vitest';
import { calculateMarketIndicators } from './indicator.service.js';
import { requiredCandleCount } from '../config/indicator.config.js';
import type { MarketData } from '../types/market.js';

function risingMarketData(length: number, price = 400): MarketData {
    return {
        price: {
            symbol: 'BTCUSDT',
            price,
        },
        candles: Array.from({ length }, (_, index) => {
            const close = 100 + index;

            return {
                timestamp: index,
                open: close - 1,
                high: close + 2,
                low: close - 2,
                close,
                volume: 1000,
            };
        }),
    };
}

describe('calculateMarketIndicators', () => {
    it('calculates EMA 300 and Stochastic 100 over a full warm-up window', () => {
        const marketData = risingMarketData(requiredCandleCount());

        const result = calculateMarketIndicators(marketData);

        expect(result).toHaveProperty('ema300');
        expect(result).toHaveProperty('stochastic');

        // A linear ramp has an exact EMA solution, so this is an independent
        // expectation rather than a recorded snapshot.
        expect(result.ema300).toBeCloseTo(849.5, 6);
        expect(result.stochastic).toBeGreaterThanOrEqual(0);
        expect(result.stochastic).toBeLessThanOrEqual(100);
    });

    it('does not collapse EMA into the SMA of the same window', () => {
        const marketData = risingMarketData(requiredCandleCount());

        const result = calculateMarketIndicators(marketData);
        const sma = marketData.candles.reduce(
            (sum, candle) => sum + candle.close,
            0,
        ) / marketData.candles.length;

        expect(result.ema300).not.toBeCloseTo(sma, 6);
    });

    it('reacts to bars appended after the window, not only to the window itself', () => {
        const warmed = risingMarketData(requiredCandleCount());
        const baseline = calculateMarketIndicators(warmed);

        const extended = calculateMarketIndicators({
            ...warmed,
            candles: [
                ...warmed.candles,
                {
                    timestamp: warmed.candles.length,
                    open: 1000,
                    high: 1200,
                    low: 1000,
                    close: 1200,
                    volume: 1000,
                },
            ],
        });

        expect(extended.ema300).toBeGreaterThan(baseline.ema300);
    });

    it('throws when the window cannot warm the EMA up', () => {
        expect(() => calculateMarketIndicators(risingMarketData(300)))
            .toThrow(expect.objectContaining({
                name: 'MarketDataError',
                code: 'MARKET_INSUFFICIENT_HISTORY',
            }));
    });

    it('accepts exactly the required warm-up size', () => {
        expect(requiredCandleCount()).toBe(900);

        expect(() => calculateMarketIndicators(
            risingMarketData(requiredCandleCount()),
        )).not.toThrow();
    });
});
