/**
 * PHASE 1. An asset and an instrument, as values.
 *
 * The roadmap asks for these to be separate types, and it is worth being
 * precise about why, because the reason is not tidiness — it is that the
 * current string cannot carry the distinction the code needs.
 *
 * `symbol: z.string().regex(/^[A-Z0-9]{1,32}$/)` accepts `BTCUSDT` and
 * `BTCUSDC` and `ETHBTC` and `BTCEUR` equally, and knows nothing about which
 * part is the thing being traded and which part is what it is traded for. Every
 * consumer of a symbol in this codebase has to decide that for itself, and
 * three of them decide it by slicing a constant. That is the thing this file
 * replaces, not the typing.
 *
 * **The split is a lookup, not a rule.** There is no arithmetic that turns
 * `BTCUSDT` into BTC and USDT — the boundary has to be told. `ETHBTC` sells ETH
 * for BTC, and BTC is itself an asset, so the quote is not always a fiat
 * currency. `BTCEUR` is not a crypto pair at all, which is a third thing. So
 * the registry of quote currencies is not bookkeeping around this parser; it is
 * an input to it, and a parser without one is guessing.
 *
 * **Which is why the registry has to exist before the parser, not after.** That
 * ordering is the opposite of what feels natural — build the type, then use it —
 * and it is forced: the type's constructor is the lookup.
 *
 * Nothing here does I/O, and nothing here is wired to the database yet. PHASE 2
 * puts the registry in configuration, PHASE 32 puts it in the database, and until
 * then this is a pure function over a list somebody hands it. That is
 * deliberate: a domain that cannot be tested without a database is a domain
 * whose tests only prove that the database works.
 *
 * **The frozen contract is not touched here.** `MarketAnalysis` carries
 * `symbol: string` and the frontend reads it, so widening that field is a
 * decision with a consumer on the other side of it. This file adds the ability
 * to parse and validate an instrument; changing what crosses the wire is
 * PHASE 22's work and it belongs to the owner.
 */

/** Something that is traded. `BTC` is an asset; `BTCUSDT` is not. */
export interface Asset {
    readonly symbol: string;
    readonly name: string;
    /** USDT, USD, BTC — what this asset is priced in when it is an asset. */
    readonly category: AssetCategory;
    readonly status: AssetStatus;
}

export type AssetCategory = 'crypto' | 'fiat';
export type AssetStatus = 'active' | 'inactive' | 'unknown';

/**
 * Why a market may not be traded, as a value rather than as a union.
 *
 * **These six strings were written down four times.** The union type, the
 * `DESCRIBE` record beside it, and two Zod enums in the API schemas — four
 * declarations that agreed on the day they were written and that nothing held
 * together afterwards. A type does not survive at runtime, so a validator cannot
 * be derived from it; every consumer that needs to validate rather than annotate
 * has to retype the list, and a reason added to the domain without being added
 * to both schemas would be **accepted by the compiler and rejected by the
 * request**, which is the worst of the two failures: a defect that only appears
 * in production, on the one instrument somebody suspended.
 *
 * So the list is a tuple, the type is derived from it, and the schemas are built
 * from it. Adding a reason is now one edit, and the compiler refuses the change
 * if anything still has a `Record` over the old set.
 */
export const TRADABILITY_REASONS = [
    'unknown_instrument',
    'base_inactive',
    'quote_inactive',
    'instrument_inactive',
    'base_unknown',
    'quote_unknown',
] as const;

export type TradabilityReason = (typeof TRADABILITY_REASONS)[number];

/**
 * Something that can be bought and sold: a base asset and what it is priced
 * in. The pair is the tradable thing, and it is a different thing from either
 * half — which is the whole reason the roadmap wants two types.
 */
export interface Instrument {
    /** As venues write it: `BTCUSDT`. */
    readonly ticker: string;
    readonly base: Asset;
    readonly quote: Asset;
    /**
     * `crypto` when both halves are crypto, `fiat` when the quote is not,
     * `mixed` for BTC-priced pairs, and `unknown` when the quote is not in the
     * registry yet.
     *
     * Not a function of the two categories, because `ETHBTC` is not an
     * `ETHUSDT`, and a signal sized in a stablecoin is not one sized in a
     * coin that moves. Calling all three of them `crypto` and hoping is what
     * a single `symbol: string` has been doing.
     *
     * `unknown` is the third answer the type needed and did not have. Without
     * it an unregistered quote has to be guessed, and the guess is always
     * `crypto` — which is wrong for `BTCBRL`, and confidently wrong, which is
     * the worst way to be wrong about a market you are about to size a signal
     * in. This is the same failure the project has been making all year in
     * larger forms: an assertion whose type has no third answer cannot be
     * refuted by its own output.
     */
    readonly market: MarketKind;
}

export type MarketKind = 'crypto' | 'fiat' | 'mixed' | 'unknown';

/**
 * Splits a ticker into base and quote.
 *
 * Longest suffix wins, and the reason is not a preference. Given a quote list
 * containing both `BTC` and `USDT`, the naive right-to-left scan finds `USDT`
 * for `BTCUSDT` and `BTC` for `ETHBTC` — correct in both. Given `BTCUSDT` and
 * a list containing `USDT` and `T`, a short-suffix-first scan splits it as
 * `BTCUSD` / `T`, which is not a market anyone trades. Sorting the candidates
 * longest first makes the answer depend on the most specific reading, and makes
 * it stable when someone adds a three-letter quote to the registry later.
 *
 * Returns `null` rather than guessing. A ticker whose base would be empty, or
 * whose base would be a single character, is not a pair, and returning null is
 * what lets a caller tell "this is not an instrument" from "this is an
 * instrument I have never seen".
 */
export function splitTicker(
    ticker: string,
    quotes: readonly string[],
): { base: string; quote: string } | null {
    if (!/^[A-Z0-9]{3,32}$/.test(ticker)) {
        return null;
    }

    const byLength = [...new Set(quotes)].sort((a, b) => b.length - a.length);

    for (const quote of byLength) {
        if (quote.length === 0 || quote.length >= ticker.length) {
            continue;
        }

        // The candidate has to actually be the end of the ticker. The first
        // version of this omitted the check and returned BTC/USDT for BTCUSDC —
        // it took the longest quote that left a two-character base and never
        // asked whether that quote was there. `string` cannot refute that; the
        // test that concatenates the answer back together can.
        if (!ticker.endsWith(quote)) {
            continue;
        }

        const base = ticker.slice(0, ticker.length - quote.length);

        // A one-character base is what a bad split looks like, and admitting it
        // would turn a typo into a tradeable-looking instrument.
        if (base.length >= 2) {
            return { base, quote };
        }
    }

    return null;
}

/** Builds an instrument, or null when the ticker is not a pair in `quotes`. */
export function instrumentFrom(
    ticker: string,
    assets: ReadonlyMap<string, Asset>,
    quotes: readonly string[],
): Instrument | null {
    const split = splitTicker(ticker, quotes);

    if (!split) {
        return null;
    }

    const base = assets.get(split.base);
    const quote = assets.get(split.quote);

    // An unknown half still yields an instrument, marked unknown: refusing to
    // name an asset that is not in the registry yet would mean a new market
    // cannot be added without a code change, which is the property this whole
    // milestone exists to remove.
    const baseAsset = base ?? unknownAsset(split.base);
    const quoteAsset = quote ?? unknownAsset(split.quote);

    return {
        ticker,
        base: baseAsset,
        quote: quoteAsset,
        market: marketKind(baseAsset, quoteAsset),
    };
}

function unknownAsset(symbol: string): Asset {
    return { symbol, name: symbol, category: 'crypto', status: 'unknown' };
}

export function marketKind(base: Asset, quote: Asset): MarketKind {
    if (quote.status === 'unknown') {
        // Not `crypto` by default. The quote is what decides what kind of market
        // this is, and an unrecognised one could be a fiat currency that has
        // simply not been registered yet.
        return 'unknown';
    }

    if (quote.category !== 'crypto') {
        return 'fiat';
    }

    if (base.status === 'unknown') {
        // The quote is known to be crypto, and a pair priced in crypto is a
        // crypto pair whatever the base turns out to be. Knowing the base is
        // what makes it `mixed`, and that can wait for the registry.
        return 'crypto';
    }

    return base.category === 'crypto' ? 'crypto' : 'mixed';
}

/**
 * Whether a string is an instrument rather than something else that happens to
 * be a string in this system.
 *
 * Written down because the codebase is full of strings that are not markets:
 * `1h`, `binance`, `consensus-primary`, `donchian-20`, `EMA 300`. A parser
 * that accepted them would be a bug with a plausible-looking input, and the
 * only defence is refusing clearly.
 */
export function looksLikeTicker(value: string): boolean {
    return /^[A-Z0-9]{3,32}$/.test(value);
}

/** The market's own name, which is not always the ticker's own name. */
export function label(instrument: Instrument): string {
    return instrument.market === 'fiat' || instrument.market === 'unknown'
        ? `${instrument.base.symbol}/${instrument.quote.symbol}`
        : instrument.ticker;
}
