import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockRepository } = vi.hoisted(() => ({
    mockRepository: {
        record: vi.fn(),
        list: vi.fn((): unknown[] => []),
    },
}));

vi.mock('./signal-history.repository', () => ({
    getSignalHistoryRepository: () => mockRepository,
}));

import { getSignalHistory, recordSignalHistory, summarizeHistory } from './signal-history.service';

import { marketConfig } from '../config/market.config';

import type { SignalHistoryEntry } from './signal-history.types';

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

describe('recordSignalHistory', () => {
    beforeEach(() => {
        mockRepository.record.mockClear();
        mockRepository.list.mockClear();
    });

    it('records the entry into the repository', () => {
        const entry = makeEntry();

        recordSignalHistory(entry);

        expect(mockRepository.record).toHaveBeenCalledWith(entry);
    });

    it('swallows repository failures and logs a warning instead', () => {
        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('database is locked');
        });

        const logger = { warn: vi.fn() };

        expect(() => recordSignalHistory(makeEntry(), logger)).not.toThrow();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
            event: 'signal_history_record_failed',
        });
    });

    it('swallows repository failures even without a logger', () => {
        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('database is locked');
        });

        expect(() => recordSignalHistory(makeEntry())).not.toThrow();
        expect(mockRepository.record).toHaveBeenCalledTimes(1);
    });
});

describe('getSignalHistory', () => {
    it('reads entries for the configured market symbol', () => {
        const entries = [makeEntry()];

        mockRepository.list.mockReturnValueOnce(entries);

        expect(getSignalHistory(24)).toEqual(entries);
        expect(mockRepository.list).toHaveBeenCalledWith(
            marketConfig.symbol,
            24,
        );
    });
});

const HOUR_MS = 3_600_000;
const DAY_START = 1_737_936_000_000;

// Build a newest-first sample, one entry per hour.
function entriesNewestFirst(
    states: Array<SignalHistoryEntry['signal']>,
): SignalHistoryEntry[] {
    return states.map((signal, index) => makeEntry({
        timestamp: DAY_START - index * HOUR_MS,
        signal,
    }));
}

describe('summarizeHistory', () => {
    it('returns an empty summary for an empty history', () => {
        expect(summarizeHistory([])).toEqual({
            currentSignal: null,
            currentDurationHours: null,
            currentDurationBounded: false,
            changes24h: 0,
            lastTransition: null,
            previousDurationHours: null,
            previousDurationBounded: false,
            sampleHours: 0,
        });
    });

    it('reports a single record without duration claims beyond it', () => {
        const summary = summarizeHistory(entriesNewestFirst(['SHORT']));

        expect(summary).toEqual({
            currentSignal: 'SHORT',
            currentDurationHours: 1,
            currentDurationBounded: false,
            changes24h: 0,
            lastTransition: null,
            previousDurationHours: null,
            previousDurationBounded: false,
            sampleHours: 1,
        });
    });

    it('measures a stable LONG run and reports zero changes', () => {
        const summary = summarizeHistory(entriesNewestFirst(['LONG', 'LONG', 'LONG']));

        expect(summary.currentSignal).toBe('LONG');
        expect(summary.currentDurationHours).toBe(3);
        expect(summary.currentDurationBounded).toBe(false);
        expect(summary.changes24h).toBe(0);
        expect(summary.lastTransition).toBeNull();
    });

    it('measures a stable SHORT run and reports zero changes', () => {
        const summary = summarizeHistory(entriesNewestFirst(['SHORT', 'SHORT']));

        expect(summary.currentSignal).toBe('SHORT');
        expect(summary.currentDurationHours).toBe(2);
        expect(summary.currentDurationBounded).toBe(false);
        expect(summary.changes24h).toBe(0);
        expect(summary.lastTransition).toBeNull();
    });

    it('detects a LONG → SHORT transition with the previous run duration', () => {
        const entries = entriesNewestFirst(['SHORT', 'LONG', 'LONG', 'LONG', 'LONG']);
        const summary = summarizeHistory(entries);

        expect(summary.currentSignal).toBe('SHORT');
        expect(summary.currentDurationHours).toBe(1);
        expect(summary.currentDurationBounded).toBe(true);
        expect(summary.changes24h).toBe(1);
        expect(summary.lastTransition).toEqual({
            from: 'LONG',
            to: 'SHORT',
            timestamp: DAY_START,
        });
        expect(summary.previousDurationHours).toBe(4);
        expect(summary.previousDurationBounded).toBe(false);
    });

    it('detects a SHORT → LONG transition', () => {
        const summary = summarizeHistory(entriesNewestFirst(['LONG', 'SHORT', 'SHORT']));

        expect(summary.lastTransition).toEqual({
            from: 'SHORT',
            to: 'LONG',
            timestamp: DAY_START,
        });
        expect(summary.changes24h).toBe(1);
        expect(summary.previousDurationHours).toBe(2);
    });

    it('counts multiple transitions (LONG → NEUTRAL → SHORT)', () => {
        const summary = summarizeHistory(
            entriesNewestFirst(['SHORT', 'NEUTRAL', 'LONG']),
        );

        expect(summary.changes24h).toBe(2);
        expect(summary.lastTransition).toEqual({
            from: 'NEUTRAL',
            to: 'SHORT',
            timestamp: DAY_START,
        });
        expect(summary.previousDurationHours).toBe(1);
        expect(summary.previousDurationBounded).toBe(true);
    });

    it('counts one transition for NEUTRAL → LONG', () => {
        const summary = summarizeHistory(entriesNewestFirst(['LONG', 'NEUTRAL']));

        expect(summary.changes24h).toBe(1);
        expect(summary.lastTransition).toEqual({
            from: 'NEUTRAL',
            to: 'LONG',
            timestamp: DAY_START,
        });
    });

    it('counts changes by signal differences, not snapshot count', () => {
        const summary = summarizeHistory(
            entriesNewestFirst(['NEUTRAL', 'SHORT', 'SHORT', 'LONG', 'LONG', 'LONG']),
        );

        expect(summary.changes24h).toBe(2);
    });

    it('leaves previous duration unbounded when history starts mid-run', () => {
        // The LONG run is cut off by the start of the sample, so its true
        // duration is unknown; only the recorded hours are reported.
        const summary = summarizeHistory(entriesNewestFirst(['SHORT', 'LONG']));

        expect(summary.previousDurationHours).toBe(1);
        expect(summary.previousDurationBounded).toBe(false);
    });

    it('treats missing hours as gaps without interpolating durations', () => {
        // Records at 10:00, 12:00, 14:00 (newest-first: SHORT 14:00, LONG
        // 12:00, LONG 10:00): the 11:00 and 13:00 hours are unknown, so the
        // LONG run counts 2 recorded hours, never a presumed span.
        const entries = [
            makeEntry({ timestamp: DAY_START, signal: 'SHORT' }),
            makeEntry({ timestamp: DAY_START - 2 * HOUR_MS, signal: 'LONG' }),
            makeEntry({ timestamp: DAY_START - 4 * HOUR_MS, signal: 'LONG' }),
        ];

        const summary = summarizeHistory(entries);

        expect(summary.previousDurationHours).toBe(2);
        expect(summary.previousDurationBounded).toBe(false);
    });

    it('reports bounded current duration when an older state exists', () => {
        const summary = summarizeHistory(
            entriesNewestFirst(['SHORT', 'SHORT', 'SHORT', 'LONG', 'LONG']),
        );

        expect(summary.currentSignal).toBe('SHORT');
        expect(summary.currentDurationHours).toBe(3);
        expect(summary.currentDurationBounded).toBe(true);
        expect(summary.changes24h).toBe(1);
        expect(summary.lastTransition).toEqual({
            from: 'LONG',
            to: 'SHORT',
            timestamp: DAY_START - 2 * HOUR_MS,
        });
        expect(summary.previousDurationHours).toBe(2);
        expect(summary.previousDurationBounded).toBe(false);
    });
});
