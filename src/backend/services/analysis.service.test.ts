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

        expect(result.indicators).toHaveProperty(
            'ema300',
        );

        expect(result.indicators).toHaveProperty(
            'stochastic',
        );

        expect(result.signal).toHaveProperty(
            'signal',
        );

        expect(result.signal).toHaveProperty(
            'confidence',
        );

        expect(result.signal).toHaveProperty(
            'reason',
        );

        expect(result.timestamp).toBeTypeOf('number');
    });
});
