/**
 * The currency a pair's notional volume is counted in.
 *
 * Display only. The backend sends volume in the pair's quote currency without
 * naming it, and the panel has to say "USDT" next to the number for the number to
 * mean anything.
 *
 * Longest match wins, so `ETHBTC` is quoted in BTC rather than being read as an
 * `ETHB` pair on a `TC` quote. The list is deliberately short: it covers what the
 * project can actually be pointed at, and a guess for a pair not in it costs
 * nothing worse than the same guess the symbol already makes.
 */

const QUOTE_ASSETS = [
    'USDT',
    'USDC',
    'FDUSD',
    'TUSD',
    'BUSD',
    'USDP',
    'DAI',
    'BTC',
    'ETH',
    'BNB',
    'EUR',
    'TRY',
    'BRL',
    'RUB',
    'UAH',
] as const;

const UNKNOWN_QUOTE = 'USDT';

export function quoteAssetOf(symbol: string): string {
    const upper = symbol.toUpperCase();

    let match = '';

    for (const candidate of QUOTE_ASSETS) {
        if (
            candidate.length > match.length &&
            upper.length > candidate.length &&
            upper.endsWith(candidate)
        ) {
            match = candidate;
        }
    }

    return match === '' ? UNKNOWN_QUOTE : match;
}
