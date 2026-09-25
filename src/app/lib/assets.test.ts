import { describe, expect, it } from 'vitest';

import { getAssetInfo, parseSymbol } from './assets';

describe('parseSymbol', () => {
    it('splits a USDT pair into base and quote', () => {
        expect(parseSymbol('BTCUSDT')).toEqual({ base: 'BTC', quote: 'USDT' });
    });

    it('handles other quote currencies', () => {
        expect(parseSymbol('ETHUSDC')).toEqual({ base: 'ETH', quote: 'USDC' });
        expect(parseSymbol('LTCBTC')).toEqual({ base: 'LTC', quote: 'BTC' });
    });

    it('normalises to uppercase', () => {
        expect(parseSymbol('btcusdt')).toEqual({ base: 'BTC', quote: 'USDT' });
    });

    it('falls back to the whole symbol as the base when no quote matches', () => {
        expect(parseSymbol('SOMECOIN')).toEqual({ base: 'SOMECOIN', quote: null });
        expect(parseSymbol('')).toEqual({ base: '', quote: null });
    });
});

describe('getAssetInfo', () => {
    it('returns configured metadata for a known asset', () => {
        expect(getAssetInfo('BTCUSDT')).toEqual({
            ticker: 'BTC',
            name: 'Bitcoin',
            glyph: '₿',
            quote: 'USDT',
        });
    });

    it('degrades gracefully for an unknown asset instead of breaking', () => {
        const info = getAssetInfo('ETHUSDT');

        expect(info.ticker).toBe('ETH');
        expect(info.name).toBe('ETH');
        expect(info.quote).toBe('USDT');
        expect(info.glyph.length).toBeGreaterThan(0);
    });
});