import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { analyzeMarket } from './analysis.service.js';
import * as marketService from '../market/market.service.js';
import { freshMarketData } from '../test-support/market-data-result.js';
import { MarketDataError } from '../errors/market-data.error.js';
import * as historyRepository from '../history/signal-history.repository.js';

import type { SignalHistoryRepository } from '../history/signal-history.repository.js';
import type { SignalHistoryEntry } from '../history/signal-history.types.js';
import type { MockInstance } from 'vitest';

const marketDataFixture = {
    price: {
        symbol: 'BTCUSDT',
        price: 200,
    },
    candles: Array.from(
        { length: 900 },
        (_, index) => ({
            timestamp: index,
            open: 100,
            high: 100 + index,
            low: 100,
            close: 100 + index,
            volume: 1000,
        }),
    ),
};

/**
 * Waits until at least `expected` entries are readable, then hands them back.
 *
 * `analyzeMarket` fires the history write and forgets about it — deliberately,
 * because against a network database awaiting it would turn "fail open" into
 * "fail slow" (see the comment in analysis.service.ts). So the row lands some
 * time after the analysis is already resolved, and reading immediately after
 * `await analyzeMarket()` would be racing the write rather than testing it.
 * Polling for it is exactly what the production timing looks like from outside.
 */
async function waitForRecordedEntries(
    expected: number,
    limit = 10,
): Promise<SignalHistoryEntry[]> {
    let entries: SignalHistoryEntry[] = [];

    await vi.waitFor(
        async () => {
            entries = await historyRepository
                .getSignalHistoryRepository()
                .list('BTCUSDT', limit);

            if (entries.length < expected) {
                throw new Error(
                    `only ${entries.length} of ${expected} entries recorded so far`,
                );
            }
        },
        // Generous: a write that loses a race is retried, and the default one
        // second is not a lot of budget for a round trip on a loaded machine.
        { timeout: 5_000, interval: 25 },
    );

    return entries;
}

/**
 * `analyzeMarket` → signal history, end to end against the real repository.
 *
 * There is no in-memory database and no `databasePath` to pass any more: these
 * tests run against the PostgreSQL schema the test setup file gives this file,
 * with `signal_history` and `indicator_vote` truncated before each test. Only
 * the market layer is substituted — everything below it is production code.
 */
describe('analysis → signal history integration', () => {
    let marketDataSpy: MockInstance;
    let repositorySpy: MockInstance | undefined;

    beforeEach(() => {
        marketDataSpy = vi.spyOn(marketService, 'getMarketData')
            .mockResolvedValue(freshMarketData(marketDataFixture));
    });

    afterEach(() => {
        marketDataSpy.mockRestore();
        repositorySpy?.mockRestore();
    });

    it('records a successful analysis into signal history', async () => {
        const analysis = await analyzeMarket();

        const entries = await waitForRecordedEntries(1);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            timestamp: analysis.timestamp,
            symbol: 'BTCUSDT',
            signal: 'LONG',
            consensus: 61,
            price: 200,
        });
    });

    it('does not record history when the analysis fails', async () => {
        marketDataSpy.mockRejectedValueOnce(
            new MarketDataError('upstream unavailable'),
        );

        await expect(analyzeMarket()).rejects.toBeInstanceOf(MarketDataError);

        // The recording is the last step of a successful analysis, so a failure
        // upstream leaves nothing in flight and nothing to wait for.
        expect(
            await historyRepository
                .getSignalHistoryRepository()
                .list('BTCUSDT', 10),
        ).toHaveLength(0);
    });

    it('keeps the analysis working when history persistence fails', async () => {
        const realRepository = historyRepository.getSignalHistoryRepository();

        // Only `record` is broken: the rest of the interface still answers, so
        // the failure reads as a storage outage rather than a missing module.
        const failingRepository: SignalHistoryRepository = {
            record: () => Promise.reject(
                new Error('history storage unavailable'),
            ),
            list: (symbol, limit, before) =>
                realRepository.list(symbol, limit, before),
            schemaVersion: () => realRepository.schemaVersion(),
            durabilitySettings: () => realRepository.durabilitySettings(),
        };

        repositorySpy = vi
            .spyOn(historyRepository, 'getSignalHistoryRepository')
            .mockReturnValue(failingRepository);

        const analysis = await analyzeMarket();

        expect(analysis.price).toBe(200);
        expect(analysis.signal.signal).toBe('LONG');
    });

    it('does not create duplicates for concurrent analyses in the same hour', async () => {
        vi.useFakeTimers({
            toFake: ['Date'],
            now: new Date('2026-01-15T12:30:00Z'),
        });

        try {
            const [first, second] = await Promise.all([
                analyzeMarket(),
                analyzeMarket(),
            ]);

            expect(first.timestamp).toBe(second.timestamp);
        } finally {
            // Restored before the wait below: only `Date` is faked, but the
            // poll has to be able to use real timers either way.
            vi.useRealTimers();
        }

        // Two analyses, one hour bucket, and the upsert keeps the newer row.
        expect(await waitForRecordedEntries(1)).toHaveLength(1);
    });
});
