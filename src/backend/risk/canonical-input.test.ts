import { describe, expect, it } from 'vitest';

import { canonicalInputHash, canonicalize } from './canonical-input.js';
import { linearPerpInput } from './fixtures.js';

/**
 * The canonical form is the reproducibility contract: the same facts must
 * serialize to the same bytes whatever order the JSON keys came in, and a
 * missing field must not hash differently from an explicitly absent one.
 */

describe('canonicalize', () => {
    it('is invariant under key insertion order, at any depth', () => {
        const first = {
            b: { y: 2, x: 1 },
            a: [1, { z: 3, y: 2 }],
        };
        const second = {
            a: [1, { y: 2, z: 3 }],
            b: { x: 1, y: 2 },
        };

        expect(canonicalize(first)).toBe(canonicalize(second));
    });

    it('keeps array order, because a candle series is ordered data', () => {
        expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    });

    it('normalizes negative zero', () => {
        expect(canonicalize({ value: -0 })).toBe(canonicalize({ value: 0 }));
    });

    it('treats an undefined property as absent', () => {
        expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    });
});

describe('canonicalInputHash', () => {
    it('is a stable 64-character digest for an identical input', () => {
        const first = canonicalInputHash(linearPerpInput());
        const second = canonicalInputHash(linearPerpInput());

        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when the market facts change', () => {
        const base = canonicalInputHash(linearPerpInput());
        const moved = canonicalInputHash(linearPerpInput({ currentPrice: 41001 }));

        expect(base).not.toBe(moved);
    });
});
