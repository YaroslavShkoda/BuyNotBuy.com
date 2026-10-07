/**
 * The market configuration's front door.
 *
 * This file was 787 lines holding the whole configuration stack at once —
 * schema, environment reading, capability parsing, defaults, the assembled
 * value and the cross-field refusals — and is now only the imports, so the
 * thirty files that read `marketConfig` keep one address while the pieces
 * live where each concern is legible on its own:
 *
 * - `market.schema.ts` — the shapes: venue vocabulary, capability rows, the
 *   config schema and its types. Pure declarations; no side effects.
 * - `market.env.ts` — the only place `process.env` is read, with the parsers
 *   for the settings that need more than a split, and the two refusals that
 *   are about a *setting* rather than a shape.
 * - `market.capabilities.ts` — the `venue=MARKETS@intervals` grammar and its
 *   parser, or the derived deployment description when it is unset.
 * - `market.defaults.ts` — the literals a deployment gets when it sets
 *   nothing, in the exact form the environment takes them.
 * - `market.runtime.ts` — the assembled `marketConfig`, and the checks
 *   between fields no single field can carry.
 */

export { MAX_CANDLE_LIMIT } from './market.defaults.js';
export { marketConfig } from './market.runtime.js';
export type { MarketConfig, MarketProviderName } from './market.schema.js';
export { MarketProviderSchema } from './market.schema.js';
