import { describe, expect, it } from 'vitest';

import {
    formatMomentumPercent,
    formatPercent,
    formatSignedPercent,
} from './format-momentum';

describe('percent formatters', () => {
    it('renders a fraction of price as a percentage', () => {
        expect(formatPercent(0.0042)).toBe('0.42%');
        expect(formatPercent(0)).toBe('0.00%');
        expect(formatPercent(1)).toBe('100.00%');
    });

    it('never signs an unsigned range', () => {
        // A range is never above or below anything. A leading plus on ATR would
        // read as a direction the value does not carry.
        expect(formatPercent(0.05)).not.toMatch(/^\+/);
        expect(formatPercent(0.05)).toBe('5.00%');
    });

    it('signs a direction', () => {
        expect(formatSignedPercent(0.0018)).toBe('+0.18%');
        expect(formatSignedPercent(-0.0018)).toBe('-0.18%');
        expect(formatSignedPercent(0)).toBe('0.00%');
    });

    it('gives the same result for the same input', () => {
        // Formatting that varies between renders makes a number look like it is
        // moving when it is not.
        expect(formatPercent(0.1234)).toBe(formatPercent(0.1234));
        expect(formatSignedPercent(-0.9876)).toBe(formatSignedPercent(-0.9876));
    });

    it('keeps momentum on its own scale, where the value is already a percent', () => {
        // Momentum is a rate of change in percent; ATR and MACD are stored as
        // fractions. Conflating the two would multiply by 100 twice and show
        // 0.42% as 42.00%.
        expect(formatMomentumPercent(0.42)).toBe('+0.42%');
    });

    it('respects the requested number of decimals', () => {
        expect(formatPercent(0.12345, 1)).toBe('12.3%');
        expect(formatPercent(0.12345, 3)).toBe('12.345%');
    });
});
