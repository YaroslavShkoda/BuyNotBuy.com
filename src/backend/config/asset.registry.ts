/**
 * PHASE 2. The asset registry, in configuration, validated at the boundary.
 *
 * The parser in `domain.ts` takes a list of quote currencies as an argument
 * because a pure function has to be given its input. This is where that list
 * stops being an argument, and the payoff is the one thing a list-as-parameter
 * could never buy: **a bad symbol now fails at startup with a sentence that says
 * which half was not understood.**
 *
 * Until now, `MARKET_SYMBOL=XRPBRL` passed validation, the process started, and
 * the failure arrived from a venue at whatever hour the first candle was
 * requested — as an HTTP 400 whose message names a symbol the system cannot
 * parse. Now it is a refusal to start, and it says which of the two halves is
 * missing from the registry.
 *
 * This is PHASE 2 and not PHASE 32. The registry lives in configuration because
 * that is where the rest of this project's settings live, and Zod-validated
 * because an unvalidated settings file is a string that happens to have a
 * default. PHASE 32 moves the same shape into a table, which is a different
 * place to store the same answer and a different thing to migrate to.
 *
 * **Adding an asset still needs a configuration change, and that is the honest
 * state of the world.** PHASE 14 is what removes it, by learning categories from
 * the data rather than by having someone type them. Until then the registry is
 * the explicit list of what this system understands, and a market it does not
 * list is not a market it quietly guesses about.
 */

import { z } from 'zod';
import type { Asset } from '../instruments/domain.js';
import { instrumentFrom, splitTicker } from '../instruments/domain.js';

const TICKER = /^[A-Z0-9]{2,12}$/;

const AssetSchema = z.object({
    symbol: z
        .string()
        .regex(TICKER, { message: 'Asset symbol must be an uppercase alphanumeric ticker' }),
    name: z.string().min(1),
    category: z.enum(['crypto', 'fiat']),
    status: z.enum(['active', 'inactive']).default('active'),
});

/**
 * The minimum is one and the maximum is deliberately not set.
 *
 * A registry that cannot be empty is the one constraint worth having here: a
 * system with no known assets cannot say what a symbol means, and a failure at
 * startup beats a system that starts and then cannot parse its own
 * configuration.
 */
const AssetRegistrySchema = z.object({
    assets: z.array(AssetSchema).min(1),
    /**
     * Currencies a market can be quoted in. Separate from the assets above
     * because the two are used for different questions: this list says where a
     * ticker ends, the assets say what the halves are.
     */
    quoteCurrencies: z.array(z.string().regex(TICKER)).min(1),
});

type AssetRegistryConfig = z.infer<typeof AssetRegistrySchema>;

const parseRegistry = (
    source: string,
    parseJson: (raw: string) => unknown,
): AssetRegistryConfig => {
    const parsed = AssetRegistrySchema.safeParse(parseJson(source));

    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'корень'}: ${issue.message}`)
            .join('; ');

        throw new Error(
            `Asset registry is not usable, so the process refuses to start: ${issues}`,
        );
    }

    // Two assets with the same symbol would make `get` order-dependent, and a
    // lookup that depends on file order is not a registry.
    const seen = new Set<string>();
    for (const asset of parsed.data.assets) {
        if (seen.has(asset.symbol)) {
            throw new Error(
                `Asset registry lists ${asset.symbol} more than once, ` +
                    'so which one a ticker resolves to would depend on the order they were written in',
            );
        }

        seen.add(asset.symbol);
    }

    return parsed.data;
};

const readRegistry = (): AssetRegistryConfig =>
    parseRegistry(
        process.env.ASSET_REGISTRY ?? DEFAULT_REGISTRY_JSON,
        (raw) => JSON.parse(raw) as unknown,
    );

/**
 * The default registry, written out rather than shipped in a file, for the same
 * reason the other config defaults are: a value that has to be found somewhere
 * else is a value nobody changes.
 *
 * Three crypto assets and the currencies they are quoted in, which is what
 * `BTCUSDT` and `BTCBRL`-shaped questions need. `BRL` is here precisely because
 * its absence produced the `unknown` answer, and an answer of `unknown` that
 * nobody can act on is the same as no answer.
 */
const DEFAULT_REGISTRY_JSON = JSON.stringify({
    assets: [
        { symbol: 'BTC', name: 'Bitcoin', category: 'crypto' },
        { symbol: 'ETH', name: 'Ethereum', category: 'crypto' },
        { symbol: 'XRP', name: 'XRP', category: 'crypto' },
        { symbol: 'USDT', name: 'Tether', category: 'crypto' },
        { symbol: 'USDC', name: 'USD Coin', category: 'crypto' },
        { symbol: 'USD', name: 'US Dollar', category: 'fiat' },
        { symbol: 'EUR', name: 'Euro', category: 'fiat' },
        { symbol: 'BRL', name: 'Brazilian Real', category: 'fiat' },
    ],
    quoteCurrencies: ['USDT', 'USDC', 'BTC', 'USD', 'EUR', 'BRL'],
});

const assetRegistryConfig = readRegistry();

const index = new Map<string, Asset>(
    assetRegistryConfig.assets.map((asset) => [asset.symbol, asset]),
);

/** Every asset the system knows, in registry order. */
export const knownAssets: readonly Asset[] = assetRegistryConfig.assets;

/** Currencies a market may be quoted in. */
export const quoteCurrencies: readonly string[] = assetRegistryConfig.quoteCurrencies;

export function asset(symbol: string): Asset | null {
    return index.get(symbol) ?? null;
}

export function resolveInstrument(ticker: string) {
    return instrumentFrom(ticker, index, assetRegistryConfig.quoteCurrencies);
}

/**
 * Candidate splits of a ticker that has no registered quote at its end.
 *
 * A ticker only reaches this function when the usual split failed, so the
 * question is which end of it somebody meant to be the quote. The signal is the
 * base: if some suffix leaves a base the registry recognises, that suffix is
 * what was meant. `BTCXYZ` is not three equal guesses — the first three
 * characters are a known asset, and the rest is a quote nobody has registered.
 */
function impliedQuote(ticker: string): { base: string; quote: string } | null {
    for (let size = Math.min(5, ticker.length - 2); size >= 2; size -= 1) {
        const base = ticker.slice(0, ticker.length - size);

        if (index.has(base)) {
            return { base, quote: ticker.slice(ticker.length - size) };
        }
    }

    return null;
}

/**
 * Explains what is wrong with a symbol in terms a human can act on.
 *
 * The failure this replaces produced a venue's HTTP 400 with a body naming a
 * symbol the system cannot parse, hours after start-up. The cases are kept
 * apart because the fixes are different edits: a typo needs correcting, an
 * unknown base needs adding to `assets`, an unknown quote needs adding to
 * `quoteCurrencies`, and those are three different changes to two different
 * lists in the same file.
 */
export function describeUnresolved(ticker: string): string {
    const split = splitTicker(ticker, assetRegistryConfig.quoteCurrencies);

    if (!split) {
        // In this codebase a string that is not a market is very often an
        // interval, and `1h` deserves to be told that rather than being told it
        // is in the wrong case. A technically true and completely useless
        // answer is what a case check produces here.
        if (/^[0-9]+[mhdw]$/i.test(ticker)) {
            return `${ticker} is an interval, not a market`;
        }

        if (/^[a-z0-9]+$/.test(ticker) && !/^[A-Z0-9]+$/.test(ticker)) {
            return `${ticker} is not uppercase; venues write tickers in uppercase`;
        }

        if (!TICKER.test(ticker)) {
            return `${ticker} is not shaped like a ticker at all`;
        }

        const implied = impliedQuote(ticker);

        if (implied) {
            return (
                `${ticker} looks like ${implied.base}/${implied.quote}, but ` +
                `${implied.quote} is not a registered quote currency. ` +
                `Known: ${assetRegistryConfig.quoteCurrencies.join(', ')}`
            );
        }

        return (
            `${ticker} does not end in a registered quote currency ` +
            `(${assetRegistryConfig.quoteCurrencies.join(', ')}), ` +
            'and neither end of it is an asset this registry knows'
        );
    }

    const missing = [
        !index.has(split.base) ? `base ${split.base}` : null,
        !index.has(split.quote) ? `quote ${split.quote}` : null,
    ].filter((entry): entry is string => entry !== null);

    if (missing.length === 0) {
        return `${ticker} resolves, so this is a different problem than a registry one`;
    }

    return (
        `${ticker} is missing from the asset registry: ${missing.join(' and ')}` +
        `. Add ${missing.join(' and ')} to ASSET_REGISTRY`
    );
}
