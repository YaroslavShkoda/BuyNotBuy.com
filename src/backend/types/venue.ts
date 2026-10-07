/**
 * The venues this application can read.
 *
 * **The word was declared twice and both declarations were exported.** One lived
 * in the market configuration (now `config/market.schema.ts`) as
 * `z.infer<typeof MarketProviderSchema>` and the
 * other in `market/providers/provider-http.ts` as the union `'binance' |
 * 'bitget' | 'mock'`. Both named `MarketProviderName`, both reached the public
 * surface, and they were structurally identical — which is exactly why nobody
 * noticed. Two identical types assign to each other without complaint, so the
 * duplication cost nothing until the two sets stopped matching, at which point
 * the type system would have been the thing making it difficult.
 *
 * The cost was already visible without any divergence at all. `config` cannot
 * import `market` — the layer table does not allow it, and `config` is in
 * UNIVERSAL while `market` is not — so the config side had to declare its own
 * copy and then assert one into the other:
 *
 *     venue: MarketProviderSchema.parse('bitget') as MarketProviderName
 *
 * Parsing a constant string through a validator and casting the result back to
 * the type the validator was built from. The expression is `'bitget'`. It was
 * there because the two declarations were separate, and it would keep the
 * validator honest about nothing.
 *
 * `types/` is the home for the same reason `direction.ts` is: a word that the
 * configuration layer and a provider module both need, and which no single layer
 * owns. The SQL is left alone — provider columns live inside migration strings,
 * and old migrations are not rewritten.
 */
export const MARKET_VENUES = ['binance', 'bitget', 'mock'] as const;

export type MarketProviderName = (typeof MARKET_VENUES)[number];