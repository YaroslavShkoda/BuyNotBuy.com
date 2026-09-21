import { describe, expect, it } from 'vitest';

import { marketDataProvider } from './market.provider';

import { BinanceProvider } from './providers/binance.provider';

describe('marketDataProvider', () => {
    it('creates BinanceProvider for the binance configuration', () => {
        expect(marketDataProvider).toBeInstanceOf(BinanceProvider);
    });
});
