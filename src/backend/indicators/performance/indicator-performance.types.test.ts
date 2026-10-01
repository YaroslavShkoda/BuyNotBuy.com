import { describe, expect, it } from 'vitest';

import {
    FORWARD_HORIZON_KEYS,
    FORWARD_HORIZON_NAMES,
    FORWARD_HORIZONS,
} from './indicator-performance.types.js';

import type { ForwardHorizon } from './indicator-performance.types.js';

/**
 * The horizon vocabulary, which used to be a `string[]` wearing its name.
 *
 * `FORWARD_HORIZON_NAMES` was `Object.keys(FORWARD_HORIZONS) as
 * ForwardHorizon[]`. The cast was not decoration: `Object.keys` returns
 * `string[]`, and the cast was the whole argument that the keys were horizons.
 * Everything downstream took it on trust — `indicator-vote.repository.ts` builds
 * one SQL column per entry and filters pending votes by it — so a horizon that
 * appeared in the record without the array being revisited would have entered
 * the system as a plain string.
 *
 * There is a second half to it that no type can catch on its own: a **missed**
 * horizon. Adding `'48h'` to the record and to the list is two edits, and the
 * type accepts either alone. So the list is asserted against the record below,
 * which is the only statement that makes them one thing.
 */
describe('forward horizons', () => {
    it('names exactly the horizons the record carries', () => {
        // The two edits that could drift apart. Everything else in the system
        // reads one or the other.
        expect([...FORWARD_HORIZON_NAMES].sort()).toEqual(
            Object.keys(FORWARD_HORIZONS).sort(),
        );
    });

    it('gives every horizon a positive span, and the keys it claims', () => {
        for (const horizon of FORWARD_HORIZON_NAMES) {
            expect(FORWARD_HORIZONS[horizon]).toBeGreaterThan(0);
        }

        // A horizon of zero hours would settle on the bar it was published from,
        // which is not a forward return and not an error either.
        expect(FORWARD_HORIZONS['1h']).toBeLessThan(FORWARD_HORIZONS['24h']);
    });

    it('accepts a member of the vocabulary and refuses a stranger', () => {
        // The type and the value are the same declaration now, so this cannot
        // drift from one without the other — which is the point. Before, the
        // type was written out and the list was cast from `Object.keys`, and
        // the two could disagree in either direction.
        const known: ForwardHorizon = FORWARD_HORIZON_KEYS[0];

        expect(FORWARD_HORIZON_NAMES).toContain(known);
        expect(FORWARD_HORIZON_NAMES).not.toContain('48h' as ForwardHorizon);
    });

    it('keeps the record keyed by the horizon, not by any string', () => {
        // A compile-time property, asserted as a value one. The table used to be
        // `Record<string, number>`, so a horizon missing from it was a lookup
        // returning `undefined` and a multiplication that produced `NaN` on a
        // measurement rather than on a request.
        expect(Object.keys(FORWARD_HORIZONS).every((key) =>
            (FORWARD_HORIZON_NAMES as readonly string[]).includes(key),
        )).toBe(true);
    });
});