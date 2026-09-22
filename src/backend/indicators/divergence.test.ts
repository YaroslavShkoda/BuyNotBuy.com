import { describe, expect, it } from 'vitest';

import {
    detectDivergence,
    type DivergencePoint,
} from './divergence';

function createPoint(
    index: number,
    price: number,
    momentum: number,
): DivergencePoint {
    return {
        index,
        price,
        momentum,
    };
}

describe('detectDivergence', () => {
    it('detects bullish divergence', () => {
        const previous = createPoint(100, 90000, -500);
        const current = createPoint(150, 88000, -300);

        const result = detectDivergence(
            previous,
            current,
        );

        expect(result.type).toBe('BULLISH');

        expect(result.previous).toEqual(previous);
        expect(result.current).toEqual(current);
    });

    it('detects bearish divergence', () => {
        const previous = createPoint(100, 90000, 500);
        const current = createPoint(150, 92000, 300);

        const result = detectDivergence(
            previous,
            current,
        );

        expect(result.type).toBe('BEARISH');

        expect(result.previous).toEqual(previous);
        expect(result.current).toEqual(current);
    });

    it('returns NONE when price and momentum move in the same direction', () => {
        const previous = createPoint(100, 90000, -500);
        const current = createPoint(150, 92000, -300);

        const result = detectDivergence(
            previous,
            current,
        );

        expect(result.type).toBe('NONE');
    });

    it('returns NONE when neither price nor momentum makes the required move', () => {
        const previous = createPoint(100, 90000, 500);
        const current = createPoint(150, 90000, 500);

        const result = detectDivergence(
            previous,
            current,
        );

        expect(result.type).toBe('NONE');
    });

    it('returns NONE when both values move in the opposite combination', () => {
        const previous = createPoint(100, 90000, -500);
        const current = createPoint(150, 88000, -700);

        const result = detectDivergence(
            previous,
            current,
        );

        expect(result.type).toBe('NONE');
    });

    it('preserves the indices of divergence points', () => {
        const previous = createPoint(123, 90000, -500);
        const current = createPoint(187, 88000, -300);

        const result = detectDivergence(
            previous,
            current,
        );

        expect(result.previous.index).toBe(123);
        expect(result.current.index).toBe(187);
    });
});
