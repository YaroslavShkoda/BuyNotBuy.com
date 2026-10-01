import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKET_VENUES } from './venue.js';

/**
 * The venue vocabulary, written out more than once.
 *
 * **It was declared twice and both declarations were exported.** One inferred
 * from a Zod enum in `config/market.config.ts`, one written as a union in
 * `market/providers/provider-http.ts`. They had the same name and the same
 * members, which is precisely why nothing caught it: two identical types assign
 * to each other without complaint. The duplication was already costing
 * something — `config` may not import `market`, so the config side had to
 * validate a literal through a schema and cast the result back —
 *   `MarketProviderSchema.parse('bitget') as MarketProviderName`, an expression
 *   whose value is `'bitget'`.
 *
 * A type is not a runtime value, so no behavioural test can notice a vocabulary
 * being retyped: both copies answer every input identically, and the failure
 * appears only when someone adds a fourth venue to one and not the other. That
 * is why this reads source rather than calling anything.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The forms the vocabulary may take in production source. */
const DECLARATIONS = [
    "'binance' | 'bitget' | 'mock'",
    "['binance', 'bitget', 'mock']",
];

const declares = (source: string): boolean =>
    DECLARATIONS.some((form) => source.includes(form));

/**
 * Files whose content is not production code.
 *
 * Tests name the forbidden form in order to forbid it, and this file is the
 * proof that doing so does not count as a declaration. Migrations carry the
 * venue list inside SQL strings that cannot import a TypeScript value.
 */
const NOT_SOURCE = (relativePath: string): boolean =>
    relativePath.startsWith('migrations') || relativePath.startsWith('research/');

function sources(directory: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === 'test-support') {
            continue;
        }

        const absolute = join(directory, entry);

        if (statSync(absolute).isDirectory()) {
            found.push(...sources(absolute));

            continue;
        }

        // Tests are skipped during the walk rather than filtered afterwards,
        // because this file is itself under `types/` and names the form it is
        // forbidding.
        if (
            absolute.endsWith('.ts') &&
            !absolute.endsWith('.d.ts') &&
            !absolute.endsWith('.test.ts')
        ) {
            found.push(absolute);
        }
    }

    return found;
}

const asRelative = (file: string): string =>
    relative(root, file).split(sep).join('/');

describe('the venue vocabulary has exactly one declaration', () => {
    it('lives in a layer both the config and the providers can import', () => {
        // `config` is UNIVERSAL and `market` is not, and the layer table does
        // not allow `config → market`. That restriction is the reason the word
        // was declared twice, and `types/` is where a word that both need
        // belongs.
        const declaring = sources(join(root, 'types'))
            .filter((file) => declares(readFileSync(file, 'utf8')))
            .map(asRelative)
            .sort();

        expect(declaring).toEqual(['types/venue.ts']);
    });

    it('is not written out anywhere else in production source', () => {
        // The property that needs holding. A fourth venue added to the
        // configuration but not to the providers would pass every behavioural
        // test and fail at the first request, on the venue nobody tested.
        const elsewhere = sources(root)
            .map(asRelative)
            .filter((path) => !path.startsWith('test-support'))
            .filter((path) => !NOT_SOURCE(path))
            .filter((path) => path !== 'types/venue.ts')
            .filter((path) => declares(readFileSync(join(root, path), 'utf8')))
            .sort();

        expect(elsewhere).toEqual([]);
    });

    it('is what the configuration validator accepts, and nothing more', async () => {
        // The copy that source reading cannot catch: it was an inferred type
        // rather than a written one, so it left no spelling behind. The schema
        // is built from the tuple now, and this asserts it — on the schema's own
        // options, because an assertion about two constants and nothing in
        // between is a test that cannot fail.
        const { MarketProviderSchema } = await import('../config/market.config.js');

        expect(MarketProviderSchema.options).toEqual([...MARKET_VENUES]);

        // And it refuses a venue that does not exist, which is the property the
        // configuration exists to have: naming a venue nobody implements should
        // fail here rather than at the first request.
        expect(() => MarketProviderSchema.parse('kraken')).toThrow();
    });
});