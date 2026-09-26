import { describe, expect, it } from 'vitest';

import {
    findDivergencePair,
} from './divergence-pairing.js';

describe('findDivergencePair', () => {
    it('pairs two price bottoms with two different momentum bottoms', () => {
        const result = findDivergencePair(
            [2, 5],
            [6, 13],
            20,
        );

        expect(result).toEqual({
            previousPriceIndex: 2,
            previousMomentumIndex: 6,
            currentPriceIndex: 5,
            currentMomentumIndex: 13,
        });
    });

    it('returns null when there are not enough price extrema', () => {
        expect(
            findDivergencePair(
                [5],
                [6, 13],
                20,
            ),
        ).toBeNull();
    });

    it('returns null when there are not enough momentum extrema', () => {
        expect(
            findDivergencePair(
                [2, 5],
                [6],
                20,
            ),
        ).toBeNull();
    });

    it('returns null when momentum extrema cannot be paired', () => {
        expect(
            findDivergencePair(
                [2, 5],
                [20, 30],
                5,
            ),
        ).toBeNull();
    });

    it('throws when max distance is negative', () => {
        expect(() =>
            findDivergencePair(
                [2, 5],
                [6, 13],
                -1,
            ),
        ).toThrow(
            'Divergence max distance must be greater than or equal to 0',
        );
    });
});
