import { describe, expect, it } from 'vitest';
import { filterMarkets, type MarketOption } from './market-switcher';

const market = (ticker: string, name?: string, active = false): MarketOption => ({
    ticker,
    href: `/market/${ticker}`,
    active,
    name,
});

const registry: readonly MarketOption[] = [
    market('BTCUSDT', 'Bitcoin', true),
    market('ETHUSDT', 'Ethereum'),
    market('SOLUSDT', 'Solana'),
    market('ETHBTC', 'Ethereum'),
    market('EURUSD', 'Euro'),
    market('XRPUSDT'),
];

describe('the market switcher filter', () => {
    it('returns the whole list for a blank query', () => {
        expect(filterMarkets(registry, '')).toEqual(registry);
        expect(filterMarkets(registry, '   ')).toEqual(registry);
    });

    it('matches a ticker as a case-insensitive substring', () => {
        expect(filterMarkets(registry, 'sol').map((row) => row.ticker)).toEqual(['SOLUSDT']);
        expect(filterMarkets(registry, 'USDT').map((row) => row.ticker)).toEqual([
            'BTCUSDT',
            'ETHUSDT',
            'SOLUSDT',
            'XRPUSDT',
        ]);
    });

    it('matches the registry name, not just the ticker', () => {
        expect(filterMarkets(registry, 'solana').map((row) => row.ticker)).toEqual(['SOLUSDT']);
        expect(filterMarkets(registry, 'Bit').map((row) => row.ticker)).toEqual(['BTCUSDT']);
    });

    it('matches a name without registering case', () => {
        expect(filterMarkets(registry, 'ethereum').map((row) => row.ticker)).toEqual([
            'ETHUSDT',
            'ETHBTC',
        ]);
    });

    it('keeps a market without a name searchable by its ticker alone', () => {
        expect(filterMarkets(registry, 'xrp').map((row) => row.ticker)).toEqual(['XRPUSDT']);
        expect(filterMarkets(registry, 'ripple')).toEqual([]);
    });

    it('answers an empty list, not an error, when nothing matches', () => {
        expect(filterMarkets(registry, 'doge')).toEqual([]);
    });

    it('never treats the query as a pattern', () => {
        // A query is text a person typed, not a regex: "usd(" must filter,
        // not throw.
        expect(() => filterMarkets(registry, 'usd(')).not.toThrow();
        expect(filterMarkets(registry, '.').map((row) => row.ticker)).toEqual([]);
    });
});
