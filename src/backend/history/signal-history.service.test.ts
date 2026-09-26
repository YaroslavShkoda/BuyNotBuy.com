import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockRepository } = vi.hoisted(() => ({
    mockRepository: {
        record: vi.fn(),
        list: vi.fn((): unknown[] => []),
    },
}));

vi.mock('./signal-history.repository.js', () => ({
    getSignalHistoryRepository: () => mockRepository,
}));

import { getSignalHistory, getSignalHistoryBacklogSize, recordSignalHistory, flushSignalHistoryBacklog, summarizeHistory } from './signal-history.service.js';

import { marketConfig } from '../config/market.config.js';

import type { SignalHistoryEntry } from './signal-history.types.js';

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

describe('history write backlog', () => {
    beforeEach(() => {
        mockRepository.record.mockReset();
        mockRepository.record.mockImplementation(() => {});
        mockRepository.list.mockReset();
        mockRepository.list.mockReturnValue([]);

        // The buffer is a module singleton, so anything an earlier test left
        // behind has to go before these tests count on its size.
        flushSignalHistoryBacklog();
    });

    it('keeps an entry that failed to write instead of losing it', () => {
        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('database is locked');
        });

        const entry = makeEntry({ price: 42 });

        recordSignalHistory(entry);

        // A hole in the history reads as "the signal never changed", which is
        // exactly the wrong conclusion to draw from missing data.
        expect(getSignalHistoryBacklogSize()).toBe(1);

        mockRepository.record.mockClear();
        flushSignalHistoryBacklog();

        expect(mockRepository.record).toHaveBeenCalledWith(entry);
        expect(getSignalHistoryBacklogSize()).toBe(0);
    });

    it('does nothing when there is nothing to retry', () => {
        mockRepository.record.mockClear();

        expect(flushSignalHistoryBacklog()).toBe(0);
        expect(mockRepository.record).not.toHaveBeenCalled();
    });

    it('keeps retrying on a later attempt after a second failure', () => {
        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('locked');
        });

        recordSignalHistory(makeEntry({ price: 1 }));

        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('still locked');
        });

        flushSignalHistoryBacklog();

        expect(getSignalHistoryBacklogSize()).toBe(1);

        mockRepository.record.mockImplementation(() => {});

        expect(flushSignalHistoryBacklog()).toBe(1);
        expect(getSignalHistoryBacklogSize()).toBe(0);
    });

    it('stops at the first failure instead of hammering a broken database', () => {
        for (const price of [1, 2, 3]) {
            mockRepository.record.mockImplementationOnce(() => {
                throw new Error('locked');
            });

            recordSignalHistory(makeEntry({ price }));
        }

        expect(getSignalHistoryBacklogSize()).toBe(3);

        mockRepository.record.mockClear();
        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('locked');
        });

        flushSignalHistoryBacklog();

        // One attempt per flush: retrying all three would repeat the same
        // failing write three times per cycle.
        expect(mockRepository.record).toHaveBeenCalledTimes(1);
    });

    it('stays silent about a flush failure rather than throwing at the poller', () => {
        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('locked');
        });

        recordSignalHistory(makeEntry());

        mockRepository.record.mockImplementationOnce(() => {
            throw new Error('still locked');
        });

        const logger = { warn: vi.fn() };

        expect(() => flushSignalHistoryBacklog(logger)).not.toThrow();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'signal_history_flush_failed' }),
            'signal_history_flush_failed',
        );
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
            undefined,
        );
    });

    it('passes a page boundary down instead of filtering in memory', () => {
        const entries = [makeEntry()];

        mockRepository.list.mockReturnValueOnce(entries);

        getSignalHistory(24, 1234);

        // The boundary is part of the query: reading everything and throwing
        // most of it away is how a "20 rows" endpoint ends up scanning years.
        expect(mockRepository.list).toHaveBeenCalledWith(
            marketConfig.symbol,
            24,
            1234,
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

        // One record says the signal is current, but not how long it has held:
        // the only record is the one taken now.
        expect(summary).toEqual({
            currentSignal: 'SHORT',
            currentDurationHours: 0,
            currentDurationBounded: false,
            changes24h: 0,
            lastTransition: null,
            previousDurationHours: null,
            previousDurationBounded: false,
            sampleHours: 0,
        });
    });

    it('measures a stable LONG run and reports zero changes', () => {
        const summary = summarizeHistory(entriesNewestFirst(['LONG', 'LONG', 'LONG']));

        // Records at 00:00, 23:00, 22:00: two hours have elapsed, not three.
        expect(summary.currentSignal).toBe('LONG');
        expect(summary.currentDurationHours).toBe(2);
        expect(summary.currentDurationBounded).toBe(false);
        expect(summary.changes24h).toBe(0);
        expect(summary.lastTransition).toBeNull();
    });

    it('measures a stable SHORT run and reports zero changes', () => {
        const summary = summarizeHistory(entriesNewestFirst(['SHORT', 'SHORT']));

        expect(summary.currentSignal).toBe('SHORT');
        expect(summary.currentDurationHours).toBe(1);
        expect(summary.currentDurationBounded).toBe(false);
        expect(summary.changes24h).toBe(0);
        expect(summary.lastTransition).toBeNull();
    });

    it('detects a LONG → SHORT transition with the previous run duration', () => {
        const entries = entriesNewestFirst(['SHORT', 'LONG', 'LONG', 'LONG', 'LONG']);
        const summary = summarizeHistory(entries);

        expect(summary.currentSignal).toBe('SHORT');
        // Only the newest record carries SHORT, so no time has elapsed yet.
        expect(summary.currentDurationHours).toBe(0);
        expect(summary.currentDurationBounded).toBe(true);
        expect(summary.changes24h).toBe(1);
        expect(summary.lastTransition).toEqual({
            from: 'LONG',
            to: 'SHORT',
            timestamp: DAY_START,
        });
        // The LONG run spans 01:00 back to 04:00.
        expect(summary.previousDurationHours).toBe(3);
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
        // The SHORT run spans 01:00 back to 02:00.
        expect(summary.previousDurationHours).toBe(1);
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
        // A single NEUTRAL record, so no elapsed time.
        expect(summary.previousDurationHours).toBe(0);
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
        // duration is unknown; only the elapsed span is reported.
        const summary = summarizeHistory(entriesNewestFirst(['SHORT', 'LONG']));

        expect(summary.previousDurationHours).toBe(0);
        expect(summary.previousDurationBounded).toBe(false);
    });

    it('measures durations from timestamps, not from record count', () => {
        // Records at 00:00 and 23:00 are two records but 23 elapsed hours.
        const summary = summarizeHistory(entriesNewestFirst(['SHORT', 'LONG']));

        // Previous run is the single LONG record, so it spans nothing.
        expect(summary.previousDurationHours).toBe(0);
        expect(summary.sampleHours).toBe(1);
    });

    it('survives gaps in the sample without collapsing the duration', () => {
        // Records at 00:00 SHORT, 22:00 LONG, 20:00 LONG. The missing hours
        // are gaps, not zero-duration records: the LONG run really did span
        // two hours of wall-clock time.
        const entries = [
            makeEntry({ timestamp: DAY_START, signal: 'SHORT' }),
            makeEntry({ timestamp: DAY_START - 2 * HOUR_MS, signal: 'LONG' }),
            makeEntry({ timestamp: DAY_START - 4 * HOUR_MS, signal: 'LONG' }),
        ];

        const summary = summarizeHistory(entries);

        expect(summary.previousDurationHours).toBe(2);
        expect(summary.previousDurationBounded).toBe(false);
        expect(summary.sampleHours).toBe(4);
    });

    it('reports bounded current duration when an older state exists', () => {
        const summary = summarizeHistory(
            entriesNewestFirst(['SHORT', 'SHORT', 'SHORT', 'LONG', 'LONG']),
        );

        expect(summary.currentSignal).toBe('SHORT');
        // 00:00 back to 22:00 is two hours, although three records exist.
        expect(summary.currentDurationHours).toBe(2);
        expect(summary.currentDurationBounded).toBe(true);
        expect(summary.changes24h).toBe(1);
        expect(summary.lastTransition).toEqual({
            from: 'LONG',
            to: 'SHORT',
            timestamp: DAY_START - 2 * HOUR_MS,
        });
        expect(summary.previousDurationHours).toBe(1);
        expect(summary.previousDurationBounded).toBe(false);
    });

    it('ignores transitions older than 24 hours', () => {
        // A week of hourly records. The signal is LONG from 01:00 to 30:00
        // (29 hours ago) and SHORT everywhere else, so exactly one of the two
        // flips falls inside the window the field promises to cover.
        const states: Array<SignalHistoryEntry['signal']> = [];

        for (let hour = 0; hour < 168; hour += 1) {
            states.push(
                hour >= 1 && hour <= 30 ? 'LONG' : 'SHORT',
            );
        }

        const summary = summarizeHistory(entriesNewestFirst(states));

        expect(summary.changes24h).toBe(1);
        expect(summary.sampleHours).toBe(167);
    });

    it('counts a flip that happened 30 hours ago only in lastTransition', () => {
        const states: Array<SignalHistoryEntry['signal']> = [];

        for (let hour = 0; hour < 168; hour += 1) {
            states.push(
                hour >= 1 && hour <= 30 ? 'LONG' : 'SHORT',
            );
        }

        const summary = summarizeHistory(entriesNewestFirst(states));

        // The newest flip is still reported, it simply is not a 24h change.
        expect(summary.lastTransition).toEqual({
            from: 'LONG',
            to: 'SHORT',
            timestamp: DAY_START,
        });
    });

    it('counts every flip when the whole sample is inside 24 hours', () => {
        const summary = summarizeHistory(
            entriesNewestFirst([
                'SHORT', 'SHORT', 'LONG', 'LONG', 'NEUTRAL', 'SHORT',
            ]),
        );

        expect(summary.changes24h).toBe(3);
        expect(summary.sampleHours).toBe(5);
    });
});
