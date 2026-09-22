import { describe, expect, it } from 'vitest';

import {
    findLocalBottoms,
    findLocalTops,
} from './local-extrema';

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

    it('does not consider equal values to be a local bottom', () => {
        const values = [10, 8, 8, 12];

        expect(findLocalBottoms(values)).toEqual([]);
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

    it('does not consider equal values to be a local top', () => {
        const values = [10, 12, 12, 8];

        expect(findLocalTops(values)).toEqual([]);
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
