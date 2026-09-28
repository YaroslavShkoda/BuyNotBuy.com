import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    asset,
    describeUnresolved,
    knownAssets,
    quoteCurrencies,
    resolveInstrument,
} from './asset.registry.js';

describe('the default registry', () => {
    it('knows at least one asset and at least one quote currency', () => {
        // The one constraint worth having. A system with nothing to resolve
        // against cannot say what any symbol means, and it is better to say
        // that at startup.
        expect(knownAssets.length).toBeGreaterThan(0);
        expect(quoteCurrencies.length).toBeGreaterThan(0);
    });

    it('lists every quote currency as an asset too', () => {
        // Otherwise a quote is a thing that can end a ticker but has no name,
        // no category, and no category means no answer about what kind of
        // market it is.
        for (const quote of quoteCurrencies) {
            expect(asset(quote)).not.toBeNull();
        }
    });

    it('has no asset listed twice', () => {
        const symbols = knownAssets.map((entry) => entry.symbol);

        expect(new Set(symbols).size).toBe(symbols.length);
    });

    it('resolves a symbol that the registry is meant to resolve', () => {
        expect(resolveInstrument('BTCUSDT')?.quote.symbol).toBe('USDT');
    });
});

describe('a symbol the registry can act on', () => {
    it('answers the halves, not just the ticker', () => {
        const instrument = resolveInstrument('XRPBTC');

        expect(instrument?.base.symbol).toBe('XRP');
        expect(instrument?.quote.symbol).toBe('BTC');
    });

    it('tells a crypto pair from a fiat one without being asked', () => {
        expect(resolveInstrument('BTCUSDT')?.market).toBe('crypto');
        expect(resolveInstrument('BTCEUR')?.market).toBe('fiat');
    });

    it('resolves every pair it can build out of its own registry', () => {
        // No registry entry should resolve to nothing. A list that cannot
        // resolve itself has an entry in it that is wrong.
        fc.assert(
            fc.property(
                fc.constantFrom(...knownAssets.map((entry) => entry.symbol)),
                fc.constantFrom(...quoteCurrencies),
                (base, quote) => {
                    const instrument = resolveInstrument(base + quote);

                    if (instrument === null) {
                        // Only acceptable when the two halves are the same
                        // symbol, which is not a pair.
                        return base === quote;
                    }

                    expect(instrument.base.symbol).toBe(base);
                    expect(instrument.quote.symbol).toBe(quote);
                },
            ),
            { numRuns: 300 },
        );
    });
});

describe('describeUnresolved', () => {
    it('names an interval as an interval', () => {
        // `1h` is a real string in this codebase in six places and a market in
        // none of them. Being told it is in the wrong case would be a technically
        // true and completely useless answer.
        for (const interval of ['1h', '4h', '1d', '1w', '15m']) {
            expect(describeUnresolved(interval)).toContain('interval');
        }
    });

    it('names a lowercase ticker as a casing problem', () => {
        expect(describeUnresolved('btcusdt')).toContain('uppercase');
    });

    it('says which half is missing, because the two fixes are different edits', () => {
        // Adding `DOGE` to the asset list and adding it to the quote list are
        // not the same change, and a message that only said "unknown symbol"
        // would send whoever reads it to the wrong file. Here the quote is
        // known, so the missing half can be named exactly.
        const message = describeUnresolved('DOGEUSDT');

        expect(message).toContain('base DOGE');
        expect(message).not.toContain('quote DOGE');
    });

    it('names the quote it thinks was meant when the base is known', () => {
        // `BTCXYZ` is not three equal guesses. The first three characters are a
        // registered asset, so the rest is a quote nobody has registered, and
        // that is a different edit from adding a new base asset.
        const message = describeUnresolved('BTCXYZ');

        expect(message).toContain('BTC/XYZ');
        expect(message).toContain('quote currency');
    });

    it('lists the quote currencies when neither end is recognised', () => {
        // Nothing here is a guess worth making, so the useful answer is the
        // list. An operator reading "unknown symbol" has nothing to do with it.
        const message = describeUnresolved('FOOZZZ');

        expect(message).toContain('USDT');
        expect(message).toContain('BTC');
        expect(message.length).toBeGreaterThan(40);
    });

    it('never blames the registry for a symbol it resolves', () => {
        // Said the other way round because it is the direction the code can
        // actually be wrong in: a message factory that claims "needs
        // registering" about a working symbol would send an operator to edit a
        // registry that is already correct.
        fc.assert(
            fc.property(
                fc.constantFrom(...knownAssets.map((entry) => entry.symbol)),
                fc.constantFrom(...quoteCurrencies),
                (base, quote) => {
                    if (base === quote) {
                        return;
                    }

                    expect(describeUnresolved(base + quote)).not.toContain('missing');
                },
            ),
            { numRuns: 300 },
        );
    });

    it('says something about anything at all, rather than nothing', () => {
        // An empty or vague message is worse than a wrong one, because it looks
        // like the tool has run out of opinions.
        for (const value of ['', 'x', '1h', 'btcusdt', 'BTC', 'DOGEUSDT', '...']) {
            expect(describeUnresolved(value).length).toBeGreaterThan(0);
        }
    });
});
