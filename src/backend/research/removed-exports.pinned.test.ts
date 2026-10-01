import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Code deleted on purpose, pinned so that putting it back is a decision.
 *
 * `research/stranded-modules.test.ts` pins whole files that nothing in production
 * reaches. This is the same discipline at the finer grain the sweep from round 56
 * measured: an *exported function* in a reachable file, with no production
 * caller, whose removal was reasoned about rather than noticed.
 *
 * Each entry says why it went and what putting it back would mean. The list is
 * pinned deliberately — if somebody wires one of these up, this test fails and
 * says so, which is the moment to delete the pin having used the code, rather
 * than to leave the entry and the code to drift apart in silence.
 */
const REMOVED: readonly { name: string; file: string; why: string; unless: string }[] = [
    {
        name: 'isCached',
        file: 'market/market-freshness.ts',
        why:
            'Answered "was this served from cache rather than fetched", and the ' +
            'argument could not carry the answer: MarketFreshness is a function of ' +
            'age, venue reachability and series health, and the cache-hit branch of ' +
            'getMarketData classifies as `fresh` — the same word a successful fetch ' +
            'writes literally. It returned false for the commonest cache hit in the ' +
            'system, and three tests held it up, two of them under names that ' +
            'contradicted their own assertions.',
        unless:
            'somebody needs the fact on the wire. Then it belongs on the result as a ' +
            'field set by the three return sites, not as a function of the freshness ' +
            'state — and `/api/market` already exposes `ageMs`, which answers the ' +
            'question clients actually have.',
    },
];

describe('code deleted on purpose stays deleted until somebody needs it', () => {
    it('is not exported by the module that would carry it', () => {
        const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');

        const stillThere = REMOVED.filter(({ file, name }) => {
            const source = readFileSync(join(backend, file), 'utf8');

            return new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(source);
        }).map(({ file, name }) => `${file}#${name}`);

        expect(stillThere).toEqual([]);
    });

    it('and says why, in the file that used to hold it', () => {
        const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');

        // A removal without a reason is indistinguishable from an accident, and
        // the next reader reinvents it. This is the cheapest possible guard: the
        // explanation is not optional.
        const unexplained = REMOVED.filter(({ file, name }) => {
            const source = readFileSync(join(backend, file), 'utf8');

            return !source.includes(`Removed: \`${name}\``);
        }).map(({ file, name }) => `${file}#${name}`);

        expect(unexplained).toEqual([]);
    });
});