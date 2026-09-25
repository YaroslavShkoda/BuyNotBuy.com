// Asset metadata for the dashboard. Maps an exchange symbol ("BTCUSDT")
// to the display name and glyph shown under the asset heading.
//
// Extend the map as the platform grows to more markets. The `ticker` is the
// base currency ("BTC"), `name` is the human display name, and `glyph` is the
// compact icon rendered beside the name. Unknown symbols degrade gracefully
// to the ticker itself and a first-letter placeholder so the layout never
// breaks when a new market is added before its metadata entry is.

export interface AssetInfo {
    ticker: string;
    name: string;
    glyph: string;
    quote: string;
}

const ASSET_MAP: Record<string, Omit<AssetInfo, 'ticker' | 'quote'>> = {
    BTC: { name: 'Bitcoin', glyph: '₿' },
};

const DEFAULT_GLYPH = '◆';

/**
 * Parse a symbol like "BTCUSDT" into base ("BTC") and quote ("USDT").
 * Falls back to the full symbol as the base when no quote match is found.
 */
export function parseSymbol(symbol: string): { base: string; quote: string | null } {
    const match = /^([A-Z]+)(USDT|USDC|BTC|ETH)$/.exec((symbol ?? '').toUpperCase());

    if (match !== null) {
        return { base: match[1] ?? symbol, quote: match[2] ?? null };
    }

    return { base: (symbol ?? '').toUpperCase(), quote: null };
}

export function getAssetInfo(symbol: string): AssetInfo {
    const { base, quote } = parseSymbol(symbol);
    const meta = ASSET_MAP[base];

    return {
        ticker: base,
        name: meta?.name ?? base,
        glyph: meta?.glyph ?? base.charAt(0),
        quote: quote ?? 'USDT',
    };
}