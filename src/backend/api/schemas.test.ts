import { describe, expect, it } from 'vitest';

import {
    ApiErrorResponseSchema,
    MarketAnalysisSchema,
    MarketDataSchema,
    PriceResponseSchema,
} from './schemas';

function validAnalysis(): any {
    return {
        timestamp: 123456789,
        price: 80000,
        indicators: {
            ema300: 78000,
            stochastic: 20,
            momentum: 150,
        },
        signal: {
            signal: 'LONG',
            confidence: 67,
            reason: 'EMA 300 и Стохастик подтверждают LONG',
            indicators: [
                {
                    name: 'EMA 300',
                    signal: 'LONG',
                    reason: 'Цена выше EMA 300',
                },
                {
                    name: 'Стохастик',
                    signal: 'LONG',
                    reason: 'Стохастик ниже 15',
                },
                {
                    name: 'Momentum 100',
                    signal: 'SHORT',
                    reason: 'Momentum ниже 0',
                },
            ],
        },
        momentum: {
            period: 100,
            current: 150,
            series: [null, null, 10, 20, 150],
        },
        divergence: {
            bullish: null,
            bearish: null,
        },
    };
}

describe('API schemas', () => {
    it('1. accepts a fully valid analysis response', () => {
        expect(() => MarketAnalysisSchema.parse(validAnalysis())).not.toThrow();
    });

    it('2. rejects analysis without indicators.momentum', () => {
        const analysis = validAnalysis();
        delete analysis.indicators.momentum;

        expect(() => MarketAnalysisSchema.parse(analysis)).toThrow();
    });

    it('3. rejects unknown signal value "BUY"', () => {
        const analysis = validAnalysis();
        analysis.signal.signal = 'BUY';

        expect(() => MarketAnalysisSchema.parse(analysis)).toThrow();
    });

    it('4. rejects confidence below 0', () => {
        const analysis = validAnalysis();
        analysis.signal.confidence = -1;

        expect(() => MarketAnalysisSchema.parse(analysis)).toThrow();
    });

    it('5. rejects confidence above 100', () => {
        const analysis = validAnalysis();
        analysis.signal.confidence = 101;

        expect(() => MarketAnalysisSchema.parse(analysis)).toThrow();
    });

    it('6. accepts momentum.series containing null', () => {
        const result = MarketAnalysisSchema.parse(validAnalysis());

        expect(result.momentum.series).toContain(null);
    });

    it('7. accepts null divergence.bullish', () => {
        const result = MarketAnalysisSchema.parse(validAnalysis());

        expect(result.divergence.bullish).toBeNull();
    });

    it('8. accepts a valid bullish divergence', () => {
        const analysis = validAnalysis();
        analysis.divergence = {
            bullish: {
                type: 'BULLISH',
                previous: { index: 10, price: 90000, momentum: -500 },
                current: { index: 20, price: 89000, momentum: -200 },
            },
            bearish: null,
        };

        const result = MarketAnalysisSchema.parse(analysis);

        expect(result.divergence.bullish?.type).toBe('BULLISH');
    });

    it('9. accepts valid MarketData', () => {
        const marketData = {
            price: { symbol: 'BTCUSDT', price: 80000 },
            candles: [
                {
                    timestamp: 1,
                    open: 79000,
                    high: 81000,
                    low: 78000,
                    close: 80000,
                    volume: 100,
                },
            ],
        };

        expect(() => MarketDataSchema.parse(marketData)).not.toThrow();
    });

    it('10. rejects Candle without close', () => {
        const marketData = {
            price: { symbol: 'BTCUSDT', price: 80000 },
            candles: [
                {
                    timestamp: 1,
                    open: 79000,
                    high: 81000,
                    low: 78000,
                    volume: 100,
                },
            ],
        };

        expect(() => MarketDataSchema.parse(marketData)).toThrow();
    });

    it('11. accepts valid price response', () => {
        const price = { symbol: 'BTCUSDT', price: 80000 };

        expect(() => PriceResponseSchema.parse(price)).not.toThrow();
    });

    it('12. rejects price response of unexpected shape', () => {
        expect(() => PriceResponseSchema.parse({ value: 80000 })).toThrow();
        expect(() => PriceResponseSchema.parse({ symbol: 'BTCUSDT' })).toThrow();
    });

    it('13. accepts a valid error response', () => {
        const body = {
            error: {
                code: 'MARKET_PROVIDER_TIMEOUT',
                message: 'Market data provider timed out',
            },
        };

        expect(() => ApiErrorResponseSchema.parse(body)).not.toThrow();
    });

    it('14. error response exposes only code and message', () => {
        const body = {
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
                stack: 'Error: boom\n at ...',
                cause: { provider: 'binance' },
            },
        };

        const parsed = ApiErrorResponseSchema.parse(body);
        expect(parsed).toEqual({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
            },
        });
        expect(JSON.stringify(parsed)).not.toContain('boom');
        expect(JSON.stringify(parsed)).not.toContain('binance');
    });
});
