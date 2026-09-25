import { describe, expect, it } from 'vitest';

import {
    filterValidEntries,
    getSignalHistoryRows,
    isValidHistoryEntry,
} from './signal-history';

import type { SignalHistoryEntry } from '../types/history';

const NOW = new Date('2026-01-15T12:00:00Z');

function makeEntry(overrides: Partial<SignalHistoryEntry> = {}): SignalHistoryEntry {
    return {
        timestamp: 1_737_950_400_000,
        symbol: 'BTCUSDT',
        signal: 'SHORT',
        consensus: 67,
        price: 100_000,
        ...overrides,
    };
}

describe('history entry validation', () => {
    it('accepts a well-formed entry', () => {
        expect(isValidHistoryEntry(makeEntry())).toBe(true);
    });

    it('rejects malformed entries without crashing', () => {
        expect(isValidHistoryEntry(null)).toBe(false);
        expect(isValidHistoryEntry('SHORT')).toBe(false);
        expect(isValidHistoryEntry({})).toBe(false);
        expect(isValidHistoryEntry(makeEntry({ timestamp: 0 }))).toBe(false);
        expect(isValidHistoryEntry(makeEntry({ timestamp: Number.NaN }))).toBe(false);
        expect(isValidHistoryEntry(makeEntry({ symbol: '' }))).toBe(false);
        expect(isValidHistoryEntry(makeEntry({ signal: 'BUY' as never }))).toBe(false);
        expect(isValidHistoryEntry(makeEntry({ consensus: Number.NaN }))).toBe(false);
        expect(isValidHistoryEntry(makeEntry({ price: undefined as never }))).toBe(false);
    });

    it('filters a malformed list down to its valid entries', () => {
        const entries = [
            makeEntry(),
            null,
            makeEntry({ signal: 'LONG' }),
            { timestamp: 'not-a-number' },
        ];

        expect(filterValidEntries(entries)).toHaveLength(2);
    });

    it('returns an empty list for non-array input', () => {
        expect(filterValidEntries(undefined)).toEqual([]);
        expect(filterValidEntries(null)).toEqual([]);
        expect(filterValidEntries('entries')).toEqual([]);
    });
});

describe('history rows', () => {
    it('formats time, consensus and detects transitions between states', () => {
        const hour = 3_600_000;
        const base = Date.parse('2026-01-15T17:00:00Z');

        const entries = [
            makeEntry({ timestamp: base, signal: 'SHORT' }),
            makeEntry({ timestamp: base - hour, signal: 'SHORT' }),
            makeEntry({ timestamp: base - 2 * hour, signal: 'LONG', consensus: 33.6 }),
            makeEntry({ timestamp: base - 3 * hour, signal: 'LONG' }),
        ];

        const rows = getSignalHistoryRows(entries, NOW);

        expect(rows).toHaveLength(4);

        expect(rows[0]).toMatchObject({
            signal: 'SHORT',
            consensus: '67%',
            isTransition: false,
        });

        expect(rows[1]).toMatchObject({
            signal: 'SHORT',
            isTransition: false,
        });

        expect(rows[2]).toMatchObject({
            signal: 'LONG',
            consensus: '34%',
            isTransition: true,
        });

        expect(rows[3]).toMatchObject({
            signal: 'LONG',
            isTransition: false,
        });
    });

    it('does not mark the newest row as a transition', () => {
        const rows = getSignalHistoryRows([makeEntry()], NOW);

        expect(rows[0]?.isTransition).toBe(false);
    });

    it('clamps out-of-range consensus values', () => {
        const rows = getSignalHistoryRows([
            makeEntry({ consensus: 140 }),
            makeEntry({ timestamp: 2, consensus: -5 }),
        ], NOW);

        expect(rows[0]?.consensus).toBe('100%');
        expect(rows[1]?.consensus).toBe('0%');
    });

    it('handles an empty history', () => {
        expect(getSignalHistoryRows([], NOW)).toEqual([]);
    });
});
