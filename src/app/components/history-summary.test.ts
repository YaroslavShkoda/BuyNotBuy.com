import { describe, expect, it } from 'vitest';

import {
    formatDurationHours,
    getChangesWindowLabel,
    isValidSummary,
} from './history-summary';

import type { HistorySummary } from '../types/history';

function makeSummary(overrides: Partial<HistorySummary> = {}): HistorySummary {
    return {
        currentSignal: 'SHORT',
        currentDurationHours: 3,
        currentDurationBounded: true,
        changes24h: 2,
        lastTransition: {
            from: 'LONG',
            to: 'SHORT',
            timestamp: 1_737_950_400_000,
        },
        previousDurationHours: 4,
        previousDurationBounded: false,
        sampleHours: 24,
        ...overrides,
    };
}

describe('summary validation', () => {
    it('accepts a well-formed summary', () => {
        expect(isValidSummary(makeSummary())).toBe(true);
    });

    it('accepts an empty-history summary with nullable fields', () => {
        expect(isValidSummary(makeSummary({
            currentSignal: null,
            currentDurationHours: null,
            currentDurationBounded: false,
            lastTransition: null,
            previousDurationHours: null,
            previousDurationBounded: false,
            changes24h: 0,
            sampleHours: 0,
        }))).toBe(true);
    });

    it('rejects malformed summaries without crashing', () => {
        expect(isValidSummary(null)).toBe(false);
        expect(isValidSummary('summary')).toBe(false);
        expect(isValidSummary({})).toBe(false);
        expect(isValidSummary(makeSummary({ currentSignal: 'BUY' as never }))).toBe(false);
        expect(isValidSummary(makeSummary({ currentDurationHours: -1 }))).toBe(false);
        expect(isValidSummary(makeSummary({ currentDurationHours: 1.5 }))).toBe(false);
        expect(isValidSummary(makeSummary({ changes24h: Number.NaN }))).toBe(false);
        expect(isValidSummary(makeSummary({ currentDurationBounded: 'yes' as never }))).toBe(false);
        expect(isValidSummary(makeSummary({ sampleHours: undefined as never }))).toBe(false);

        expect(isValidSummary(makeSummary({
            lastTransition: { from: 'BUY' as never, to: 'SHORT', timestamp: 1 },
        }))).toBe(false);

        expect(isValidSummary(makeSummary({
            lastTransition: { from: 'LONG', to: 'SHORT', timestamp: Number.NaN },
        }))).toBe(false);

        expect(isValidSummary(makeSummary({ previousDurationHours: Number.NaN }))).toBe(false);
    });
});

describe('formatDurationHours', () => {
    it('marks bounded runs as plain hours', () => {
        expect(formatDurationHours(3, true)).toBe('3 Ч');
    });

    it('marks unbounded runs with a plus to avoid overclaiming', () => {
        expect(formatDurationHours(4, false)).toBe('4+ Ч');
    });

    it('renders a dash for a null duration', () => {
        expect(formatDurationHours(null, false)).toBe('—');
    });

    it('renders a run that started within the current hour as zero', () => {
        // Durations come from timestamps, so a run seen only in the newest
        // record legitimately measures zero hours.
        expect(formatDurationHours(0, true)).toBe('0 Ч');
        expect(formatDurationHours(0, false)).toBe('0+ Ч');
    });

    it('clamps malformed negative values', () => {
        expect(formatDurationHours(-5, true)).toBe('0 Ч');
    });
});

describe('getChangesWindowLabel', () => {
    it('labels a full 24-hour sample as 24', () => {
        expect(getChangesWindowLabel(24)).toBe('24 Ч');
    });

    it('still says 24 for a longer sample, because the count really is 24h', () => {
        // The backend restricts the count to the last 24 hours, so a week of
        // history does not make the label a lie.
        expect(getChangesWindowLabel(168)).toBe('24 Ч');
    });

    it('labels a partial sample honestly with its actual size', () => {
        expect(getChangesWindowLabel(7)).toBe('7 Ч');
        expect(getChangesWindowLabel(0)).toBe('0 Ч');
    });
});