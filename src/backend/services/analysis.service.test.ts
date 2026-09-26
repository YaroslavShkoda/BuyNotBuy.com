import { describe, expect, it, vi } from 'vitest';

vi.mock('../history/signal-history.service.js', () => ({
    recordSignalHistory: vi.fn(),
    getSignalHistory: vi.fn(() => []),
}));

import { analyzeMarket } from './analysis.service.js';
import * as marketService from '../market/market.service.js';
import * as divergenceService from '../indicators/divergence.service.js';
import { freshMarketData } from '../test-support/market-data-result.js';

describe('analyzeMarket', () => {
    it('builds complete market analysis', async () => {
        const divergenceSpy = vi.spyOn(divergenceService, 'analyzeDivergence');
        vi.spyOn(
            marketService,
            'getMarketData',
        ).mockResolvedValue(freshMarketData({
            price: {
                symbol: 'BTCUSDT',
                price: 200,
            },
            candles: Array.from(
                { length: 900 },
                (_, index) => ({
                    timestamp: index,
                    open: 100,
                    high: 100 + index,
                    low: 100,
                    close: 100 + index,
                    volume: 1000,
                }),
            ),
        }));

        const result = await analyzeMarket();

        expect(result.price).toBe(200);

        // 900-bar linear ramp: the exact EMA-300 lags the last close by
        // (period - 1) / 2 = 149.5. The old 300-bar window returned its seed
        // SMA (249.5) instead, which never recursed.
        expect(result.indicators.ema300).toBeCloseTo(849.5, 6);
        expect(result.indicators.stochastic).toBe(100);
        // Momentum is a rate of change now: (999 - 899) / 899 = +11.12%,
        // not a +100 dollar delta.
        expect(result.indicators.momentum).toBeCloseTo(10000 / 899, 8);
        expect(result.momentum.current).toBeCloseTo(10000 / 899, 8);

        expect(result.signal.signal).toBe('LONG');
        expect(result.signal.confidence).toBe(61);
        expect(result.signal.reason).toBe(
            'EMA 300 и Momentum 100 подтверждают LONG',
        );

        expect(result.signal.indicators).toEqual([
            {
                key: 'ema',
                name: 'EMA 300',
                signal: 'LONG',
                reason: 'Цена выше EMA 300 (3 закрытия подряд)',
                weight: expect.closeTo(1, 5),
            },
            {
                key: 'stochastic',
                name: 'Стохастик',
                signal: 'SHORT',
                reason: 'Стохастик выше 80',
                weight: expect.closeTo(1, 5),
            },
            {
                key: 'momentum',
                name: 'Momentum 100',
                signal: 'LONG',
                reason: 'Momentum выше 0',
                // +11.1% is far past the 3% that scores full conviction, so
                // the vote is saturated rather than scaled.
                weight: 1,
            },
        ]);

        expect(result.timestamp).toBeTypeOf('number');
        expect(result.momentum.period).toBe(100);
        expect(result.momentum.series).toHaveLength(900);
        expect(result.momentum.series.slice(0, 100)).toEqual(Array(100).fill(null));
        expect(result.momentum.current).toBe(result.momentum.series.at(-1));
        expect(result.indicators.momentum).toBe(result.momentum.current);
        expect(divergenceSpy).toHaveBeenCalledWith(expect.any(Array), {
            momentumPeriod: 100,
            momentumSeries: result.momentum.series,
        });
        expect(result.divergence).toEqual({ bullish: null, bearish: null });
        divergenceSpy.mockRestore();
    });
});
