import { describe, expect, it } from 'vitest';

import { quoteAssetOf } from './quote-asset';

describe('quote asset of a symbol', () => {
    it('reads the pair the project is pointed at', () => {
        expect(quoteAssetOf('BTCUSDT')).toBe('USDT');
    });

    it('prefers the longest quote, so ETHBTC is not read as an ETHB pair', () => {
        expect(quoteAssetOf('ETHBTC')).toBe('BTC');
    });

    it('ignores case', () => {
        expect(quoteAssetOf('btcusdt')).toBe('USDT');
    });

    it('distinguishes the dollar stables from each other', () => {
        expect(quoteAssetOf('BTCUSDC')).toBe('USDC');
        expect(quoteAssetOf('BTCFDUSD')).toBe('FDUSD');
    });

    it('does not mistake a pair whose base ends in a quote for a quote', () => {
        // `USDC` is in the list, so a base ending in those letters would be read
        // as a quote without the guard below.
        expect(quoteAssetOf('ETHBTC')).not.toBe('ETH');
    });

    it('falls back to USDT rather than showing an empty unit', () => {
        expect(quoteAssetOf('SOMETHING')).toBe('USDT');
    });

    it('does not call the whole symbol its own quote', () => {
        expect(quoteAssetOf('USDT')).toBe('USDT');
    });
});
