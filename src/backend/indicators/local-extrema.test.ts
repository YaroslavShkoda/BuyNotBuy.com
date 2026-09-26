import { describe, expect, it } from 'vitest';

import {
    findLocalBottoms,
    findLocalTops,
} from './local-extrema.js';

describe('findLocalBottoms', () => {
    it('finds local bottoms', () => {
        const values = [
            10,
            8,
            12,
            7,
            11,
            6,
            13,
        ];

        expect(findLocalBottoms(values)).toEqual([
            1,
            3,
            5,
        ]);
    });

    it('finds no bottoms when values are strictly increasing', () => {
        expect(findLocalBottoms([1, 2, 3, 4, 5])).toEqual([]);
    });

    it('finds no bottoms when values are strictly decreasing', () => {
        expect(findLocalBottoms([5, 4, 3, 2, 1])).toEqual([]);
    });

    it('throws when values are empty', () => {
        expect(() => findLocalBottoms([])).toThrow(
            'Local extrema requires at least one value',
        );
    });

    it('uses the specified left and right window', () => {
        const values = [
            10,
            9,
            8,
            9,
            10,
            7,
            10,
            9,
            8,
            9,
            10,
        ];

        expect(findLocalBottoms(values, 2, 2)).toEqual([
            2,
            5,
            8,
        ]);
    });

    it('reports the middle of a flat bottom instead of dropping the pivot', () => {
        // A strict comparison satisfies nothing on a plateau, so the pivot
        // used to disappear silently on any series that printed the same
        // close two hours in a row.
        expect(findLocalBottoms([10, 8, 8, 12])).toEqual([1]);

        expect(findLocalBottoms([10, 8, 8, 8, 12])).toEqual([2]);
    });

    it('treats a whole flat stretch as a single bottom', () => {
        const values = [
            10, 9, 8, 5, 5, 5, 5, 9, 10, 11, 12,
        ];

        expect(findLocalBottoms(values)).toEqual([4]);
    });

    it('still needs a full window on both sides of a plateau', () => {
        // The plateau touches the end of the series, so it is not confirmed.
        expect(findLocalBottoms([8, 8, 12])).toEqual([]);
        expect(findLocalBottoms([10, 8, 8])).toEqual([]);
    });

    it('throws when the window is zero or negative', () => {
        const values = [10, 8, 12];

        expect(() => findLocalBottoms(values, 0, 1)).toThrow(
            'Local extrema window must be greater than 0',
        );

        expect(() => findLocalBottoms(values, 1, 0)).toThrow(
            'Local extrema window must be greater than 0',
        );
    });
});

describe('findLocalTops', () => {
    it('finds local tops', () => {
        const values = [
            10,
            12,
            8,
            13,
            7,
            14,
            6,
        ];

        expect(findLocalTops(values)).toEqual([
            1,
            3,
            5,
        ]);
    });

    it('finds no tops when values are strictly increasing', () => {
        expect(findLocalTops([1, 2, 3, 4, 5])).toEqual([]);
    });

    it('finds no tops when values are strictly decreasing', () => {
        expect(findLocalTops([5, 4, 3, 2, 1])).toEqual([]);
    });

    it('uses the specified left and right window', () => {
        const values = [
            5,
            8,
            10,
            8,
            5,
            12,
            5,
            8,
            10,
            8,
            5,
        ];

        expect(findLocalTops(values, 2, 2)).toEqual([
            2,
            5,
            8,
        ]);
    });

    it('reports the middle of a flat top instead of dropping the pivot', () => {
        expect(findLocalTops([10, 12, 12, 8])).toEqual([1]);

        expect(findLocalTops([10, 12, 12, 12, 8])).toEqual([2]);
    });

    it('still needs a full window on both sides of a plateau', () => {
        expect(findLocalTops([12, 12, 8])).toEqual([]);
        expect(findLocalTops([8, 12, 12])).toEqual([]);
    });

    it('throws when the window is zero or negative', () => {
        const values = [10, 12, 8];

        expect(() => findLocalTops(values, 0, 1)).toThrow(
            'Local extrema window must be greater than 0',
        );

        expect(() => findLocalTops(values, 1, 0)).toThrow(
            'Local extrema window must be greater than 0',
        );
    });
});
