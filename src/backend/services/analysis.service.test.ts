import { describe, expect, it, vi } from 'vitest';

vi.mock('../history/signal-history.service', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { analyzeMarket } from './analysis.service';
import * as marketService from '../market/market.service';
import * as divergenceService from '../indicators/divergence.service';

describe('analyzeMarket', () => {
    it('builds complete market analysis', async () => {
        const divergenceSpy = vi.spyOn(divergenceService, 'analyzeDivergence');
        vi.spyOn(
            marketService,
            'getMarketData',
        ).mockResolvedValue({
            price: {
                symbol: 'BTCUSDT',
                price: 200,
            },
            candles: Array.from(
                { length: 300 },
                (_, index) => ({
                    timestamp: index,
                    open: 100,
                    high: 100 + index,
                    low: 100,
                    close: 100 + index,
                    volume: 1000,
                }),
            ),
        });

        const result = await analyzeMarket();

        expect(result.price).toBe(200);

        expect(result.indicators.ema300).toBe(249.5);
        expect(result.indicators.stochastic).toBe(100);
        expect(result.indicators.momentum).toBe(100);
        expect(result.momentum.current).toBe(100);

        expect(result.signal.signal).toBe('SHORT');
        expect(result.signal.confidence).toBe(67);
        expect(result.signal.reason).toBe(
            'EMA 300 и Стохастик подтверждают SHORT',
        );

        expect(result.signal.indicators).toEqual([
            {
                name: 'EMA 300',
                signal: 'SHORT',
                reason: 'Цена ниже EMA 300',
            },
            {
                name: 'Стохастик',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
            },
            {
                name: 'Momentum 100',
                signal: 'LONG',
                reason: 'Momentum выше 0',
            },
        ]);

        expect(result.timestamp).toBeTypeOf('number');
        expect(result.momentum.period).toBe(100);
        expect(result.momentum.series).toHaveLength(300);
        expect(result.momentum.series.slice(0, 100)).toEqual(Array(100).fill(null));
        expect(result.momentum.current).toBe(result.momentum.series.at(-1));
        expect(result.indicators.momentum).toBe(result.momentum.current);
        expect(divergenceSpy).toHaveBeenCalledWith(expect.any(Array), 100, 2, 2, 5, result.momentum.series);
        expect(result.divergence).toEqual({ bullish: null, bearish: null });
        divergenceSpy.mockRestore();
    });
});
