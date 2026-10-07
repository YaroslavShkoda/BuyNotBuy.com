import { z } from 'zod';
import type { MarketProviderName } from '../types/venue.js';
import { VenueCapabilitySchema } from './market.schema.js';

/**
 * Who can serve what, parsed from the deployment's own words.
 *
 * Split out of the config monolith because the capability table is its own
 * little language — the one setting with a grammar of its own — and a parser
 * with a grammar deserves its own file, where its format comment sits next to
 * the only code that implements it.
 */

/**
 * Reads the capability list, or describes the deployment from its own settings.
 *
 * Format: `binance=BTCUSDT,ETHUSDT@1m,1h;bitget=SOLUSDT@1h`. The `@` separates
 * markets from intervals because a venue serves a cross product of the two, and
 * a format that listed intervals once per market would let a deployment declare
 * BTCUSDT at 1h and ETHUSDT at nothing without the config noticing.
 */
export function parseVenueCapabilities(
    raw: string | undefined,
    primary: MarketProviderName,
    primarySymbol: string,
    fallbackSymbol: string,
    interval: string,
): z.infer<typeof VenueCapabilitySchema>[] {
    if (raw === undefined || raw.trim() === '') {
        return [
            {
                venue: primary,
                instruments: [primarySymbol],
                intervals: [interval],
            },
            {
                // Was `MarketProviderSchema.parse('bitget') as MarketProviderName`:
                // a constant string parsed through a validator and cast back to
                // the type the validator was built from, so the whole expression
                // was `'bitget'`. It existed because the two declarations of the
                // vocabulary were separate.
                venue: 'bitget' as const,
                instruments: [fallbackSymbol],
                intervals: [interval],
            },
        ].filter(
            (entry, index, all) =>
                all.findIndex((other) => other.venue === entry.venue) === index,
        );
    }

    return raw
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
            const [venuePart, marketsPart] = part.split('=');

            if (venuePart === undefined || marketsPart === undefined) {
                throw new Error(
                    `MARKET_VENUE_CAPABILITIES entry "${part}" is not "venue=MARKETS@intervals"`,
                );
            }

            const [instrumentsPart, intervalsPart] = marketsPart.split('@');

            if (instrumentsPart === undefined || intervalsPart === undefined) {
                throw new Error(
                    `MARKET_VENUE_CAPABILITIES entry for "${venuePart}" is missing the "@intervals" part`,
                );
            }

            return {
                venue: venuePart.trim(),
                instruments: instrumentsPart.split(',').map((ticker) => ticker.trim()),
                intervals: intervalsPart.split(',').map((step) => step.trim()),
            };
        })
        .map((entry) => VenueCapabilitySchema.parse(entry));
}
