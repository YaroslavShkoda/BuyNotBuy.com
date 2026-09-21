import { describe, expect, it, vi } from 'vitest';

import { analyzeMarket } from './analysis.service';
import * as marketService from '../market/market.service';

describe('analyzeMarket', () => {
    it('builds complete market analysis', async () => {
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

        expect(result.signal.signal).toBe('SHORT');
        expect(result.signal.confidence).toBe(100);
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
        ]);

        expect(result.timestamp).toBeTypeOf('number');
    });
});
