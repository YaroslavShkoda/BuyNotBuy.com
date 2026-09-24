import { describe, expect, it } from 'vitest';

import { getConfidenceWidth } from './signal-panel';

describe('signal confidence meter', () => {
    it('maps confidence to a percentage width', () => {
        expect(getConfidenceWidth(67)).toBe('67%');
        expect(getConfidenceWidth(0)).toBe('0%');
        expect(getConfidenceWidth(100)).toBe('100%');
    });

    it('clamps out-of-range values into 0-100%', () => {
        expect(getConfidenceWidth(120)).toBe('100%');
        expect(getConfidenceWidth(-5)).toBe('0%');
    });

    it('rounds fractional confidence and guards non-finite input', () => {
        expect(getConfidenceWidth(67.4)).toBe('67%');
        expect(getConfidenceWidth(Number.NaN)).toBe('0%');
        expect(getConfidenceWidth(Number.POSITIVE_INFINITY)).toBe('0%');
    });
});
