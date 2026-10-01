import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
    instrumentFrom,
    label,
    looksLikeTicker,
    marketKind,
    splitTicker,
    TRADABILITY_REASONS,
} from './domain.js';

import type { Asset } from './domain.js';

const asset = (symbol: string, category: 'crypto' | 'fiat' = 'crypto'): Asset => ({
    symbol,
    name: symbol,
    category,
    status: 'active',
});

const REGISTRY = new Map<string, Asset>([
    ['BTC', asset('BTC')],
    ['ETH', asset('ETH')],
    ['XRP', asset('XRP')],
    ['USDT', asset('USDT')],
    ['USDC', asset('USDC')],
    ['EUR', asset('EUR', 'fiat')],
    ['USD', asset('USD', 'fiat')],
]);

const QUOTES = ['USDT', 'USDC', 'BTC', 'USD', 'EUR'];

/** The same registry with a second fiat currency, for the "known quote" case. */
const REGISTRY_EXT = new Map([...REGISTRY, ['BRL', asset('BRL', 'fiat')]]);

describe('splitTicker', () => {
    it('reads a pair that everybody can read', () => {
        expect(splitTicker('BTCUSDT', QUOTES)).toEqual({ base: 'BTC', quote: 'USDT' });
    });

    it('reads the same base against a different quote', () => {
        // The case a `symbol: string` cannot express: three tickers that share
        // a prefix and differ only in what they are priced in.
        expect(splitTicker('BTCUSDC', QUOTES)).toEqual({ base: 'BTC', quote: 'USDC' });
        expect(splitTicker('BTCEUR', QUOTES)).toEqual({ base: 'BTC', quote: 'EUR' });
    });

    it('accepts a quote that is itself an asset', () => {
        // ETHBTC is BTC-priced, not USDT-priced, and a parser that assumed
        // every quote was a currency would get this wrong.
        expect(splitTicker('ETHBTC', QUOTES)).toEqual({ base: 'ETH', quote: 'BTC' });
        expect(splitTicker('XRPBTC', QUOTES)).toEqual({ base: 'XRP', quote: 'BTC' });
    });

    it('takes the longest reading, not the first that fits', () => {
        // With `T` in the registry, a short-suffix-first scan splits BTCUSDT into
        // BTCUSD / T, which is not a market anybody trades. The longest
        // candidate wins so that adding a short quote later cannot quietly
        // change what an existing ticker means.
        expect(splitTicker('BTCUSDT', ['USDT', 'T'])).toEqual({
            base: 'BTC',
            quote: 'USDT',
        });
    });

    it('is unchanged by the order the registry happens to be in', () => {
        expect(splitTicker('BTCUSDT', [...QUOTES].reverse())).toEqual(
            splitTicker('BTCUSDT', QUOTES),
        );
    });

    it('refuses a string that is a market nowhere in this system', () => {
        // These are all real strings in this codebase, and all of them are not
        // markets. A parser that took one of them would be inventing a trade.
        for (const value of [
            '1h',
            '1d',
            '4h',
            'binance',
            'bitget',
            'mock',
            'consensus-primary',
            'donchian-20',
            'EMA',
        ]) {
            expect(splitTicker(value, QUOTES)).toBeNull();
        }
    });

    it('refuses a ticker whose base would be nothing or one character', () => {
        expect(splitTicker('TUSDT', QUOTES)).toBeNull();
        expect(splitTicker('USDT', QUOTES)).toBeNull();
        expect(splitTicker('A', QUOTES)).toBeNull();
    });

    it('refuses a quote longer than the ticker itself', () => {
        // Otherwise the base is empty and the answer is a lie of a certain
        // shape: a real-looking pair with nothing in it.
        expect(splitTicker('BTC', ['BTCUSDT'])).toBeNull();
    });

    it('refuses nothing quietly on a lowercase or punctuated value', () => {
        for (const value of ['btcusdt', 'BTC-USDT', 'BTC/USDT', 'BTC USDT', '']) {
            expect(splitTicker(value, QUOTES)).toBeNull();
        }
    });

    it('reconstitutes whatever it split, for every base and quote', () => {
        // The invariant the type is supposed to guarantee, checked over 200
        // generated pairs rather than a list I chose: what comes out, put back,
        // is the ticker that went in.
        fc.assert(
            fc.property(
                fc.stringMatching(/^[A-Z0-9]{2,8}$/),
                fc.constantFrom(...QUOTES),
                (base, quote) => {
                    const split = splitTicker(base + quote, [quote]);

                    expect(split).toEqual({ base, quote });
                    expect(split && split.base + split.quote).toBe(base + quote);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('never returns a base of fewer than two characters or a quote the length of the ticker', () => {
        fc.assert(
            fc.property(
                fc.stringMatching(/^[A-Z0-9]{3,12}$/),
                fc.array(fc.constantFrom('USDT', 'BTC', 'T', 'USD', 'EUR', 'USDC'), {
                    minLength: 1,
                    maxLength: 5,
                }),
                (ticker, quotes) => {
                    const split = splitTicker(ticker, quotes);

                    if (!split) {
                        return;
                    }

                    expect(split.base.length).toBeGreaterThanOrEqual(2);
                    expect(split.quote.length).toBeLessThan(ticker.length);
                    expect(split.base + split.quote).toBe(ticker);
                },
            ),
            { numRuns: 200 },
        );
    });
});

describe('instrumentFrom', () => {
    it('builds an instrument from the registry', () => {
        const instrument = instrumentFrom('BTCUSDT', REGISTRY, QUOTES);

        expect(instrument?.ticker).toBe('BTCUSDT');
        expect(instrument?.base.symbol).toBe('BTC');
        expect(instrument?.quote.symbol).toBe('USDT');
        expect(instrument?.market).toBe('crypto');
    });

    it('tells a crypto pair from a fiat pair from a mixed one', () => {
        // Three answers rather than one. `symbol: string` answered `crypto` to
        // all of them by not answering at all, and a signal sized in USDT was
        // indistinguishable from one sized in BTC.
        expect(instrumentFrom('BTCUSDT', REGISTRY, QUOTES)?.market).toBe('crypto');
        expect(instrumentFrom('BTCEUR', REGISTRY, QUOTES)?.market).toBe('fiat');
        expect(instrumentFrom('ETHBTC', REGISTRY, QUOTES)?.market).toBe('crypto');
    });

    it('marks an asset it has not heard of as unknown rather than refusing', () => {
        // Refusing would mean a new market needs a code change, which is the
        // property this milestone exists to remove. Unknown is answerable;
        // absent is not.
        const instrument = instrumentFrom('DOGEUSDT', REGISTRY, QUOTES);

        expect(instrument?.base.symbol).toBe('DOGE');
        expect(instrument?.base.status).toBe('unknown');
    });

    it('keeps a known base even when the quote is not registered, and says the kind is unknown', () => {
        // BTCBRL is a fiat pair and BRL is not in the registry. The first
        // version called it `crypto`, because the only way to answer was to
        // assume an unknown quote was a coin. Being confidently wrong about the
        // market a signal is sized in is the worst kind of wrong, so the type
        // grew a third answer instead.
        const instrument = instrumentFrom('BTCBRL', REGISTRY, [...QUOTES, 'BRL']);

        expect(instrument?.base.status).toBe('active');
        expect(instrument?.quote.status).toBe('unknown');
        expect(instrument?.market).toBe('unknown');
    });

    it('calls a pair priced in a registered fiat currency fiat', () => {
        expect(instrumentFrom('BTCBRL', REGISTRY_EXT, [...QUOTES, 'BRL'])?.market).toBe('fiat');
    });

    it('still calls an unknown base in a known crypto quote a crypto pair', () => {
        // The quote decides what kind of market this is. Not knowing the base
        // does not change that, and refusing to answer would make every new
        // market a code change.
        expect(instrumentFrom('DOGEUSDT', REGISTRY, QUOTES)?.market).toBe('crypto');
    });

    it('returns nothing for something that is not a pair', () => {
        expect(instrumentFrom('1h', REGISTRY, QUOTES)).toBeNull();
        expect(instrumentFrom('binance', REGISTRY, QUOTES)).toBeNull();
    });

    it('preserves the ticker exactly as given', () => {
        fc.assert(
            fc.property(fc.stringMatching(/^[A-Z0-9]{2,8}$/), (base) => {
                const instrument = instrumentFrom(base + 'USDT', REGISTRY, QUOTES);

                expect(instrument?.ticker).toBe(base + 'USDT');
            }),
            { numRuns: 200 },
        );
    });
});

describe('marketKind', () => {
    it('agrees with itself, whatever the category of the two halves', () => {
        const kinds = ['crypto', 'fiat'] as const;

        for (const base of kinds) {
            for (const quote of kinds) {
                const result = marketKind(asset('A', base), asset('B', quote));

                expect(['crypto', 'fiat', 'mixed', 'unknown']).toContain(result);
            }
        }
    });

    it('answers unknown for a quote it has not heard of', () => {
        // A known base and a known fiat quote is `fiat`. A known base and an
        // unrecognised quote is not `crypto` — it is `unknown`, which is the
        // answer the type had to be able to give.
        expect(marketKind(asset('BTC'), asset('EUR', 'fiat'))).toBe('fiat');
        expect(
            marketKind(asset('BTC'), { ...asset('BRL', 'fiat'), status: 'unknown' }),
        ).toBe('unknown');
    });

    it('calls a fiat quote fiat, whatever the base is', () => {
        expect(marketKind(asset('BTC'), asset('EUR', 'fiat'))).toBe('fiat');
        expect(marketKind(asset('ETH'), asset('USD', 'fiat'))).toBe('fiat');
    });
});

describe('the strings that are already in this codebase', () => {
    it('rejects every provider name', () => {
        // `binance` and `bitget` are uppercase-alphanumeric-looking in exactly
        // the way that makes a shape check insufficient, and they are providers,
        // not markets.
        expect(looksLikeTicker('BINANCE')).toBe(true);
        expect(splitTicker('BINANCE', QUOTES)).toBeNull();
        expect(splitTicker('BITGET', QUOTES)).toBeNull();
    });

    it('rejects every interval label', () => {
        for (const interval of ['1M', '4H', '1D', '1W']) {
            expect(splitTicker(interval, QUOTES)).toBeNull();
        }
    });
});

describe('label', () => {
    it('uses the venue spelling when both halves trade on venues', () => {
        expect(label(instrumentFrom('BTCUSDT', REGISTRY, QUOTES)!)).toBe('BTCUSDT');
        expect(label(instrumentFrom('ETHBTC', REGISTRY, QUOTES)!)).toBe('ETHBTC');
    });

    it('spells out a fiat pair, because the concatenation is a lie there', () => {
        // BTCEUR is not a ticker. The venues that list it do, some of them, but
        // a symbol shown in a dashboard as `BTCEUR` tells a reader nothing.
        expect(label(instrumentFrom('BTCEUR', REGISTRY, QUOTES)!)).toBe('BTC/EUR');
    });
});

/**
 * One list of refusals, checked from every side that needs one.
 *
 * The failure this prevents is silent and late. A union type does not survive to
 * runtime, so a consumer that needs to *validate* rather than annotate has to
 * retype the six strings — and a reason added to the domain but missed in a
 * schema compiles cleanly and then rejects the request, on the one instrument
 * somebody suspended. Those six strings were written four times over before
 * this; they are written once now.
 */
describe('the reasons a market may not be traded', () => {
    it('is exactly what both API validators accept', async () => {
        const { InstrumentResponseSchema, InstrumentProblemSchema } =
            await import('../api/schemas.js');

        expect(InstrumentResponseSchema.shape.reason.unwrap().options).toEqual([
            ...TRADABILITY_REASONS,
        ]);
        expect(
            InstrumentProblemSchema.shape.error.shape.reason.unwrap().options,
        ).toEqual([...TRADABILITY_REASONS]);
    });

    it('holds for the other vocabularies the wire retypes too', async () => {
        // The measurement behind this found twelve sets written in more than one
        // file, six of them this shape: a domain vocabulary retyped inside
        // `api/schemas.ts` because a union type is erased at runtime and
        // `z.enum` wants values. Three are fixed. The rest are recorded in the
        // status document rather than swept.
        const { IndicatorSignalSchema, IndicatorKeySchema } = await import(
            '../api/schemas.js'
        );
        const { SIGNAL_DIRECTIONS } = await import('../types/direction.js');
        const { INDICATOR_KEYS } = await import('../signals/signal.types.js');

        expect(IndicatorSignalSchema.options).toEqual([...SIGNAL_DIRECTIONS]);
        expect(IndicatorKeySchema.options).toEqual([...INDICATOR_KEYS]);
    });

    it('holds for the asset vocabulary the wire retypes as well', async () => {
        // `AssetStatus` was declared four times and `AssetCategory` five — once
        // of which was an exported duplicate inside the repository that nothing
        // imported. The domain owns both, and the wire validates against the
        // domain's own tuples.
        const { InstrumentAssetSchema, InstrumentSchema } = await import(
            '../api/schemas.js'
        );
        const { ASSET_CATEGORIES, ASSET_STATUSES, MARKET_KINDS } = await import(
            './domain.js'
        );

        expect(ASSET_CATEGORIES).toContain('crypto');
        expect(ASSET_STATUSES).toContain('unknown');

        expect(InstrumentAssetSchema.shape.category.options).toEqual([
            ...ASSET_CATEGORIES,
        ]);
        expect(InstrumentAssetSchema.shape.status.options).toEqual([
            ...ASSET_STATUSES,
        ]);
        expect(InstrumentSchema.shape.market.options).toEqual([...MARKET_KINDS]);
    });

    it('does not widen the instrument status to match the asset one', async () => {
        const { ASSET_STATUSES } = await import('./domain.js');
        const { InstrumentSchema } = await import('../api/schemas.js');

        // Asserted against the schema's own options, and the first version was
        // not: it compared two constants — `['active', 'inactive']` written in
        // the test against `ASSET_STATUSES` imported from the domain — and so
        // kept passing after `status` was widened to `z.enum(ASSET_STATUSES)`,
        // which is the exact mistake the test claims to forbid. A test that
        // never looks at the code cannot notice the code changing.
        expect(InstrumentSchema.shape.status.options).toEqual(['active', 'inactive']);

        // And the reason, stated as a fact rather than as the assertion: an
        // instrument has no third state. It is not that nobody classified it,
        // it is that the pair refuses to exist without a kind.
        expect([...ASSET_STATUSES]).toContain('unknown');
    });

    it('has a sentence for every one of them', async () => {
        // `DESCRIBE` is a `Record` over the type, so a new reason does not
        // compile without a sentence. A refusal with no explanation is a
        // refusal with nothing to act on, and the six are fixed by different
        // people.
        const { AssetRepository } = await import('./asset.repository.js');

        for (const reason of TRADABILITY_REASONS) {
            expect(AssetRepository.describeReason(reason).length).toBeGreaterThan(4);
        }
    });
});
