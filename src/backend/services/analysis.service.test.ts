import { describe, expect, it } from 'vitest';
import { analyzeMarket } from './analysis.service';
import type { MarketData } from '../types/market';

describe('analyzeMarket', () => {
    it('builds complete market analysis', () => {
        const candles = Array.from(
            { length: 300 },
            (_, index) => ({
                timestamp: index,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            }),
        );

        const marketData: MarketData = {
            price: {
                symbol: 'BTCUSDT',
                price: 200,
            },
            candles,
        };

        const result = analyzeMarket(marketData);

        expect(result.price).toBe(200);
        expect(result.indicators).toHaveProperty('ema300');
        expect(result.indicators).toHaveProperty('stochastic');
        expect(result.signal.signal).toBe('LONG');
        expect(result.signal.confidence).toBe(50);
        expect(result.signal.reason).toBe(
            'Только EMA 300 подтверждает LONG',
        );
        expect(result.timestamp).toBeTypeOf('number');
    });
});
