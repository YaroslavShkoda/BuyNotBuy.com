import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockRepository } = vi.hoisted(() => ({
    // Both repository methods are promises: the driver is asynchronous now, so
    // a mock that returns an array synchronously would test a repository that
    // cannot exist any more.
    mockRepository: {
        record: vi.fn((): Promise<void> => Promise.resolve()),
        list: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
        // **Added because the mock's absence was hiding the code.** Without it,
        // every call to `maybeTrimRetention` threw `TypeError: … is not a
        // function`, the `catch` around it returned 0, and the tests passed. So
        // the housekeeping path had never run in this file — which is how a
        // throttle that starved a whole market stayed untested: the only thing
        // testing it was a mock that could not answer.
        trimRetention: vi.fn((symbol: string): Promise<number> => Promise.resolve(0)),
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
        provider: marketConfig.provider,
        interval: marketConfig.candleInterval,
        context: {
            regime: null,
            dataQuality: null,
            dataQualityUsable: null,
            dataQualityWorst: null,
        },
        ...overrides,
    };
}

describe('recordSignalHistory', () => {
    beforeEach(async () => {
        mockRepository.record.mockReset();
        mockRepository.record.mockResolvedValue(undefined);
        mockRepository.list.mockReset();
        mockRepository.list.mockResolvedValue([]);
        mockRepository.trimRetention.mockReset();
        mockRepository.trimRetention.mockResolvedValue(0);

        // The buffer is a module singleton, so anything an earlier test left
        // behind has to go before these tests count on its size or on how many
        // times the repository was called.
        await flushSignalHistoryBacklog();
        mockRepository.record.mockClear();
    });

    it('records the entry into the repository', async () => {
        const entry = makeEntry();

        await recordSignalHistory(entry);

        expect(mockRepository.record).toHaveBeenCalledWith(entry);
    });

    it('resolves rather than rejecting when the write fails, and warns instead', async () => {
        mockRepository.record.mockRejectedValueOnce(
            new Error('database is locked'),
        );

        const logger = { warn: vi.fn() };

        // History is non-critical, so a broken database must not reach the
        // analysis path. The contract is that the *promise settles fulfilled*:
        // an async function never throws synchronously either, so "did not
        // throw" alone would pass even if this rejected.
        await expect(
            recordSignalHistory(makeEntry(), logger),
        ).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
            event: 'signal_history_record_failed',
        });
    });

    it('resolves and buffers the entry even with no logger to warn through', async () => {
        mockRepository.record.mockRejectedValueOnce(
            new Error('database is locked'),
        );

        await expect(recordSignalHistory(makeEntry())).resolves.toBeUndefined();

        expect(mockRepository.record).toHaveBeenCalledTimes(1);
        // Silent is not the same as lost: the entry waits for the poller.
        expect(getSignalHistoryBacklogSize()).toBe(1);
    });
});

describe('history write backlog', () => {
    beforeEach(async () => {
        mockRepository.record.mockReset();
        mockRepository.record.mockResolvedValue(undefined);
        mockRepository.list.mockReset();
        mockRepository.list.mockResolvedValue([]);
        mockRepository.trimRetention.mockReset();
        mockRepository.trimRetention.mockResolvedValue(0);

        // The buffer is a module singleton, so anything an earlier test left
        // behind has to go before these tests count on its size or on how many
        // times the repository was called.
        await flushSignalHistoryBacklog();
        mockRepository.record.mockClear();
    });

    it('keeps an entry that failed to write instead of losing it', async () => {
        mockRepository.record.mockRejectedValueOnce(
            new Error('database is locked'),
        );

        const entry = makeEntry({ price: 42 });

        await recordSignalHistory(entry);

        // A hole in the history reads as "the signal never changed", which is
        // exactly the wrong conclusion to draw from missing data.
        expect(getSignalHistoryBacklogSize()).toBe(1);

        mockRepository.record.mockClear();

        await expect(flushSignalHistoryBacklog()).resolves.toBe(1);

        expect(mockRepository.record).toHaveBeenCalledWith(entry);
        expect(getSignalHistoryBacklogSize()).toBe(0);
    });

    it('does nothing when there is nothing to retry', async () => {
        mockRepository.record.mockClear();

        await expect(flushSignalHistoryBacklog()).resolves.toBe(0);
        expect(mockRepository.record).not.toHaveBeenCalled();
    });

    it('keeps retrying on a later attempt after a second failure', async () => {
        mockRepository.record.mockRejectedValueOnce(new Error('locked'));

        await recordSignalHistory(makeEntry({ price: 1 }));

        mockRepository.record.mockRejectedValueOnce(new Error('still locked'));

        await expect(flushSignalHistoryBacklog()).resolves.toBe(0);

        expect(getSignalHistoryBacklogSize()).toBe(1);

        mockRepository.record.mockResolvedValue(undefined);

        await expect(flushSignalHistoryBacklog()).resolves.toBe(1);
        expect(getSignalHistoryBacklogSize()).toBe(0);
    });

    it('stops at the first failure instead of hammering a broken database', async () => {
        for (const price of [1, 2, 3]) {
            mockRepository.record.mockRejectedValueOnce(new Error('locked'));

            await recordSignalHistory(makeEntry({ price }));
        }

        expect(getSignalHistoryBacklogSize()).toBe(3);

        mockRepository.record.mockClear();
        // Every entry refuses, not just the first: this is the database being
        // down, and the loop has to notice that from the flush itself. Queuing one
        // refusal would be the other case — a bad row with a working database.
        for (let pending = 0; pending < 3; pending += 1) {
            mockRepository.record.mockRejectedValueOnce(new Error('locked'));
        }

        await expect(flushSignalHistoryBacklog()).resolves.toBe(0);

        // **Two attempts, not one.** Telling "this row is bad" apart from "the
        // database is down" costs one extra attempt, because at the first entry the
        // two are indistinguishable. The bound still keeps the load flat — two
        // statements a cycle instead of one per buffered entry — and it is the
        // price of not stalling every entry behind a row that never writes.
        expect(mockRepository.record).toHaveBeenCalledTimes(2);
    });

    // This test used to say the opposite, and its name was the reason the defect
    // survived: "leaves the entries it did not attempt queued for the next flush".
    //
    // The concern behind it was real — the loop once pushed back only the entry
    // that failed, broke, and discarded everything behind it with no write and no
    // drop count. But the answer it encoded was "stop at the first failure", and
    // that answer is worse than the bug: with two markets in one buffer, one row
    // the database refuses blocked every entry behind it on every flush, for ever,
    // including the other market's. Nothing was written and nothing was reported.
    //
    // So the loop now distinguishes the two failures. Nothing written yet means the
    // database is down and the tail is handed back untouched — that is the
    // hammering case, and the test above pins it. Something written already means
    // *this row* is the problem, and the entries behind it are not what is broken.
    it('writes the entries behind a failing one, and re-queues only what failed', async () => {
        const entries = [1, 2, 3].map((price) => makeEntry({ price }));

        for (const entry of entries) {
            mockRepository.record.mockRejectedValueOnce(new Error('locked'));

            await recordSignalHistory(entry);
        }

        expect(getSignalHistoryBacklogSize()).toBe(3);

        // The second entry is refused; the first and third go through.
        mockRepository.record.mockResolvedValueOnce(undefined);
        mockRepository.record.mockRejectedValueOnce(new Error('constraint'));
        mockRepository.record.mockResolvedValueOnce(undefined);

        await expect(flushSignalHistoryBacklog()).resolves.toBe(2);

        // One entry back — the one that failed — rather than the two that the old
        // loop kept behind it.
        expect(getSignalHistoryBacklogSize()).toBe(1);

        mockRepository.record.mockResolvedValue(undefined);

        await expect(flushSignalHistoryBacklog()).resolves.toBe(1);
        expect(getSignalHistoryBacklogSize()).toBe(0);
    });

    it('gives up on an entry that keeps failing, so it cannot evict the ones that would write', async () => {
        const entries = [1, 2, 3].map((price) => makeEntry({ price }));

        for (const entry of entries) {
            mockRepository.record.mockRejectedValueOnce(new Error('locked'));

            await recordSignalHistory(entry);
        }

        // Every flush: the first entry is refused, the second and third are fine.
        // The first is what is broken, and it must not be what survives.
        for (let round = 0; round < 8; round += 1) {
            mockRepository.record.mockRejectedValueOnce(new Error('constraint'));
            mockRepository.record.mockResolvedValue(undefined);
            mockRepository.record.mockResolvedValue(undefined);

            await flushSignalHistoryBacklog();
        }

        // A re-queued entry becomes the **newest** in a buffer that evicts its
        // oldest, so an entry retried for ever would sit there protecting itself
        // while real hours were dropped — a failure that had become the mechanism
        // for losing data, which is the opposite of what a buffer is for.
        expect(getSignalHistoryBacklogSize()).toBe(0);
    });

    it('stays silent about a flush failure rather than throwing at the poller', async () => {
        mockRepository.record.mockRejectedValueOnce(new Error('locked'));

        await recordSignalHistory(makeEntry());

        mockRepository.record.mockRejectedValueOnce(new Error('still locked'));

        const logger = { warn: vi.fn() };

        // The poller awaits this on a timer, so a rejection here would become
        // an unhandled rejection instead of a retried write.
        await expect(flushSignalHistoryBacklog(logger)).resolves.toBe(0);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'signal_history_flush_failed' }),
            'signal_history_flush_failed',
        );
    });
});

describe('getSignalHistory', () => {
    beforeEach(() => {
        mockRepository.list.mockClear();
    });

    it('reads entries for the configured market symbol', async () => {
        const entries = [makeEntry()];

        mockRepository.list.mockResolvedValueOnce(entries);

        await expect(getSignalHistory(24)).resolves.toEqual(entries);
        // The series travels with the read, because the write now resolves the
        // venue for the market: a read that defaulted it would look in the series
        // nothing was written to and answer "no history" for a market that has one.
        expect(mockRepository.list).toHaveBeenCalledWith(
            marketConfig.symbol,
            24,
            undefined,
            expect.objectContaining({
                provider: expect.any(String) as unknown as string,
                interval: marketConfig.candleInterval,
            }),
        );
    });

    it('passes a page boundary down instead of filtering in memory', async () => {
        const entries = [makeEntry()];

        mockRepository.list.mockResolvedValueOnce(entries);

        await expect(getSignalHistory(24, 1234)).resolves.toEqual(entries);

        // The boundary is part of the query: reading everything and throwing
        // most of it away is how a "20 rows" endpoint ends up scanning years.
        expect(mockRepository.list).toHaveBeenCalledWith(
            marketConfig.symbol,
            24,
            1234,
            expect.objectContaining({
                provider: expect.any(String) as unknown as string,
                interval: marketConfig.candleInterval,
            }),
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
            currentObservedHours: null,
            currentGaps: 0,
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
            currentObservedHours: 1,
            currentGaps: 0,
            changes24h: 0,
            lastTransition: null,
            previousDurationHours: null,
            previousDurationBounded: false,
            sampleHours: 0,
        });
    });

    it('separates elapsed hours from the hours actually observed', () => {
        // Six hourly records, but the fourth is two hours older than the third:
        // the bucket between them was never written. The run spans six elapsed
        // hours across seven buckets, and one of those buckets is a hole — a
        // different claim from six continuous hours, and the dashboard should
        // not have to make the reader work out which one it is looking at.
        const entries = [
            { hoursAgo: 0, signal: 'SHORT' as const },
            { hoursAgo: 1, signal: 'SHORT' as const },
            { hoursAgo: 2, signal: 'SHORT' as const },
            { hoursAgo: 4, signal: 'SHORT' as const },
            { hoursAgo: 5, signal: 'SHORT' as const },
            { hoursAgo: 6, signal: 'SHORT' as const },
        ].map((entry) => ({
            timestamp: DAY_START + (24 - entry.hoursAgo) * HOUR_MS,
            symbol: 'BTCUSDT',
            signal: entry.signal,
            consensus: 60,
            price: 100,
        }));

        const summary = summarizeHistory(entries);

        expect(summary.currentDurationHours).toBe(6);
        expect(summary.currentObservedHours).toBe(6);
        expect(summary.currentGaps).toBe(1);
    });

    it('reports no gaps in a continuous run', () => {
        const summary = summarizeHistory(
            entriesNewestFirst(['SHORT', 'SHORT', 'SHORT', 'SHORT']),
        );

        expect(summary.currentGaps).toBe(0);
        expect(summary.currentObservedHours).toBe(4);
        expect(summary.currentDurationHours).toBe(3);
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

/**
 * A fresh service per test, because the throttle window is module state.
 *
 * `vi.resetModules()` plus a dynamic import is the only way to get a fresh
 * `lastTrimAt`, and it works here because the `vi.mock` factory above is
 * hoisted: the re-imported service still receives the same `mockRepository`.
 *
 * This was not the plan. The first version of this block used the file's
 * top-level `recordSignalHistory` and asserted both markets were trimmed — and
 * got `[ 'ETHUSDT' ]`. BTCUSDT had been trimmed by an earlier test in the same
 * file, its window was still open, and the second market in the same test run
 * was the one that got through.
 *
 * That is not a test artefact. **It is the defect, reproduced in miniature**:
 * within one process the first series consumes the window and the others starve,
 * which is exactly what happens on the observation loop every minute.
 */
async function serviceWithFreshWindow(): Promise<
    typeof import('./signal-history.service.js')
> {
    vi.resetModules();

    // Declared, because the service now resolves the venue for the market it is
    // writing (round 99) and the boot check from round 97 refuses a market no venue
    // serves. Without this the record throws into the backlog and the trim never
    // runs — which looks exactly like a cadence that stopped working.
    vi.stubEnv('MARKET_VENUE_CAPABILITIES', 'binance=BTCUSDT,SOLUSDT,DOGEUSDT@1h;bitget=BTCUSDT,ETHUSDT,XRPUSDT@1h');

    return import('./signal-history.service.js');
}

describe('the retention cadence is per series, not per process', () => {
    beforeEach(() => {
        mockRepository.record.mockReset();
        mockRepository.record.mockResolvedValue(undefined);
        mockRepository.trimRetention.mockReset();
        mockRepository.trimRetention.mockResolvedValue(0);
    });

    it('trims both markets, not only the one that went first', async () => {
        // **This is the item.** One timestamp for the whole process gated a
        // per-symbol delete, so the first market in `marketConfig.symbols` took
        // the window on every pass and every other market's history was never
        // trimmed — one row an hour, forever, under the limit that exists to
        // stop exactly that.
        const { recordSignalHistory: record } = await serviceWithFreshWindow();

        await record(makeEntry({ symbol: 'BTCUSDT' }));
        await record(makeEntry({ symbol: 'ETHUSDT' }));

        expect(
            mockRepository.trimRetention.mock.calls.map((call) => call[0]),
        ).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    it('still holds the cadence for one series, so the throttle is not simply removed', async () => {
        // The reason the cadence exists — a full scan per write to delete at most
        // one row. A fix that made every market trim on every write would satisfy
        // the test above while destroying the cost the code was bought with.
        const { recordSignalHistory: record } = await serviceWithFreshWindow();

        await record(makeEntry({ symbol: 'SOLUSDT' }));
        await record(makeEntry({ symbol: 'SOLUSDT' }));

        expect(
            mockRepository.trimRetention.mock.calls.filter((call) => call[0] === 'SOLUSDT'),
        ).toHaveLength(1);
    });

    it('consumes the window even when the delete fails, rather than retrying per write', async () => {
        // The failure is swallowed by design — refusing to record history because
        // housekeeping was slow trades a bounded table for a missing hour — but a
        // failing trim on every successful write is exactly the cost the cadence
        // exists to avoid, arriving through the error path.
        mockRepository.trimRetention.mockRejectedValue(new Error('statement timeout'));

        const { recordSignalHistory: record } = await serviceWithFreshWindow();

        await record(makeEntry({ symbol: 'DOGEUSDT' }));
        await record(makeEntry({ symbol: 'DOGEUSDT' }));

        expect(
            mockRepository.trimRetention.mock.calls.filter((call) => call[0] === 'DOGEUSDT'),
        ).toHaveLength(1);

        // And the history write still succeeded: the swallow covers the
        // housekeeping, not the record.
        expect(mockRepository.record).toHaveBeenCalledTimes(2);
    });

    it('gives each series its own window, so one market cannot spend the next', async () => {
        // The sharpest form of the claim, and the one a shared window fails
        // hardest: if the window were shared, BTCUSDT's first write would close
        // it and ETHUSDT's would be skipped — the reverse of the previous test.
        const { recordSignalHistory: record } = await serviceWithFreshWindow();

        await record(makeEntry({ symbol: 'BTCUSDT' }));
        await record(makeEntry({ symbol: 'BTCUSDT' }));
        await record(makeEntry({ symbol: 'ETHUSDT' }));

        expect(
            mockRepository.trimRetention.mock.calls.map((call) => call[0]),
        ).toEqual(['BTCUSDT', 'ETHUSDT']);
    });
});
