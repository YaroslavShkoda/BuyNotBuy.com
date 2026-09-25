import { describe, expect, it } from 'vitest';

import { createSignalHistoryRepository } from './signal-history.repository';

import type { SignalHistoryEntry } from './signal-history.types';

const HOUR_MS = 3_600_000;

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

describe('signal history repository', () => {
    it('stores and returns an entry with all fields preserved', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry());

        expect(repository.list('BTCUSDT', 10)).toEqual([
            makeEntry(),
        ]);
    });

    it('keeps a single record per hour and the newest analysis wins', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const hourStart = 1_737_950_400_000;

        repository.record(makeEntry({
            timestamp: hourStart + 10 * 60_000,
            signal: 'LONG',
            price: 99_000,
        }));

        repository.record(makeEntry({
            timestamp: hourStart + 40 * 60_000,
        }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(hourStart + 40 * 60_000);
        expect(entries[0]?.signal).toBe('SHORT');
        expect(entries[0]?.price).toBe(100_000);
    });

    it('does not overwrite a newer record with a late-arriving older snapshot', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const hourStart = 1_737_950_400_000;

        repository.record(makeEntry({
            timestamp: hourStart + 40 * 60_000,
        }));

        repository.record(makeEntry({
            timestamp: hourStart + 10 * 60_000,
            signal: 'LONG',
        }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.timestamp).toBe(hourStart + 40 * 60_000);
        expect(entries[0]?.signal).toBe('SHORT');
    });

    it('returns entries newest-first across hours', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const dayStart = 1_737_936_000_000;

        repository.record(makeEntry({ timestamp: dayStart + 2 * HOUR_MS }));
        repository.record(makeEntry({ timestamp: dayStart + HOUR_MS }));
        repository.record(makeEntry({ timestamp: dayStart }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 2 * HOUR_MS,
            dayStart + HOUR_MS,
            dayStart,
        ]);
    });

    it('limits the number of returned entries to the newest ones', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        const dayStart = 1_737_936_000_000;

        for (let hour = 0; hour < 5; hour += 1) {
            repository.record(makeEntry({ timestamp: dayStart + hour * HOUR_MS }));
        }

        const entries = repository.list('BTCUSDT', 2);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 4 * HOUR_MS,
            dayStart + 3 * HOUR_MS,
        ]);
    });

    it('trims retained entries down to maxEntries keeping the newest', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 3,
        });

        const dayStart = 1_737_936_000_000;

        for (let hour = 0; hour < 5; hour += 1) {
            repository.record(makeEntry({ timestamp: dayStart + hour * HOUR_MS }));
        }

        const entries = repository.list('BTCUSDT', 10);

        expect(entries.map((entry) => entry.timestamp)).toEqual([
            dayStart + 4 * HOUR_MS,
            dayStart + 3 * HOUR_MS,
            dayStart + 2 * HOUR_MS,
        ]);
    });

    it('keeps symbols independent', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry());
        repository.record(makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }));

        expect(repository.list('BTCUSDT', 10)).toEqual([makeEntry()]);
        expect(repository.list('ETHUSDT', 10)).toEqual([
            makeEntry({ symbol: 'ETHUSDT', signal: 'LONG' }),
        ]);
    });

    it('rounds consensus to an integer', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        repository.record(makeEntry({ consensus: 66.6 }));

        const entries = repository.list('BTCUSDT', 10);

        expect(entries[0]?.consensus).toBe(67);
    });

    it('returns an empty list for unknown symbol', () => {
        const repository = createSignalHistoryRepository({
            databasePath: ':memory:',
            maxEntries: 720,
        });

        expect(repository.list('BTCUSDT', 10)).toEqual([]);
    });
});
