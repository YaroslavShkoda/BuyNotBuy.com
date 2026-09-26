import { marketConfig } from '../config/market.config.js';
import { historyConfig } from '../config/history.config.js';

import { getSignalHistoryRepository } from './signal-history.repository.js';
import { createSignalHistoryWriteBuffer } from './signal-history.write-buffer.js';

import type {
    SignalHistoryEntry,
    SignalHistoryLastTransition,
    SignalHistoryLogger,
    SignalHistorySummary,
} from './signal-history.types.js';

const writeBuffer = createSignalHistoryWriteBuffer({
    maxSize: historyConfig.maxBufferedEntries,
});

// History is a non-critical subsystem: a persistence failure must never
// propagate into the market analysis path, so this wrapper is fail-open
// by contract and never throws. A failed write is buffered rather than
// dropped, so a momentary database problem leaves no hole in the record.
export function recordSignalHistory(
    entry: SignalHistoryEntry,
    logger?: SignalHistoryLogger,
): void {
    try {
        getSignalHistoryRepository().record(entry);
    } catch (error) {
        writeBuffer.push(entry);

        logger?.warn(
            {
                event: 'signal_history_record_failed',
                buffered: writeBuffer.size,
                dropped: writeBuffer.droppedCount,
                err: error,
            },
            'signal_history_record_failed',
        );
    }
}

/**
 * Retries everything that failed to write earlier.
 *
 * Entries are removed from the buffer as they are handed to the repository, so
 * a failure part-way through leaves the remaining ones queued for the next
 * attempt instead of replaying the same prefix forever. The signal is recorded
 * once per hour, so a duplicate write is idempotent anyway.
 */
export function flushSignalHistoryBacklog(logger?: SignalHistoryLogger): number {
    if (writeBuffer.size === 0) {
        return 0;
    }

    let written = 0;

    for (const entry of writeBuffer.drain()) {
        try {
            getSignalHistoryRepository().record(entry);
            written += 1;
        } catch (error) {
            writeBuffer.push(entry);

            logger?.warn(
                {
                    event: 'signal_history_flush_failed',
                    buffered: writeBuffer.size,
                    err: error,
                },
                'signal_history_flush_failed',
            );

            break;
        }
    }

    return written;
}

export function getSignalHistoryBacklogSize(): number {
    return writeBuffer.size;
}

export function getSignalHistory(limit: number, before?: number): SignalHistoryEntry[] {
    return getSignalHistoryRepository().list(marketConfig.symbol, limit, before);
}

const HOUR_MS = 3_600_000;

/** The window `changes24h` actually covers. */
const CHANGES_WINDOW_MS = 24 * HOUR_MS;

const EMPTY_SUMMARY: SignalHistorySummary = {
    currentSignal: null,
    currentDurationHours: null,
    currentDurationBounded: false,
    changes24h: 0,
    lastTransition: null,
    previousDurationHours: null,
    previousDurationBounded: false,
    sampleHours: 0,
};

/**
 * Turns a run of consecutive same-signal records into elapsed hours.
 *
 * The records are bucketed per hour, so counting them is not the same as
 * measuring the run: three records at 10:00, 11:00 and 12:00 describe a run
 * that has been going for two hours, not three. The count also collapsed
 * whenever the process was down for an hour or two, because the missing
 * buckets simply were not there to be counted.
 */
function runDurationHours(
    newestTimestamp: number,
    runStartTimestamp: number,
): number {
    return Math.max(
        0,
        Math.floor(
            (newestTimestamp - runStartTimestamp) / HOUR_MS,
        ),
    );
}

/**
 * Derives stability context from the sample of hourly snapshots, which arrive
 * newest-first.
 *
 * Semantics:
 *   - Durations are elapsed time between timestamps, never a record count, and
 *     never interpolated across a gap: "N hours" is the time between the
 *     newest record and the first record of the run.
 *   - A run is "bounded" when an older record with a different signal exists,
 *     i.e. the run start is visible in the sample. An unbounded run means the
 *     true duration may be longer ("at least N hours").
 *   - changes24h counts transitions inside the last 24 hours measured back
 *     from the newest record, so the number means what its name says even
 *     when the sample holds a week of history.
 *   - sampleHours is the elapsed span of the sample, not its record count.
 */
export function summarizeHistory(
    entries: SignalHistoryEntry[],
): SignalHistorySummary {
    // entries is non-empty, but noUncheckedIndexedAccess types the element
    // as possibly undefined, so the guard keeps the access narrow.
    const newest = entries[0];

    if (newest === undefined) {
        return EMPTY_SUMMARY;
    }

    const currentSignal = newest.signal;

    // Current run: consecutive same-signal records starting from the newest.
    let currentRun = 0;
    while (
        currentRun < entries.length &&
        entries[currentRun]?.signal === currentSignal
    ) {
        currentRun += 1;
    }

    const runStart = entries[currentRun - 1];

    // Transitions: entries are newest-first, so entries[i] is newer than
    // entries[i + 1]; a pair differs when their signals differ. Only pairs
    // that both fall inside the 24-hour window are counted.
    const windowStart = newest.timestamp - CHANGES_WINDOW_MS;

    let changes24h = 0;
    let transitionIndex: number | undefined;

    for (let i = 0; i < entries.length - 1; i += 1) {
        const newer = entries[i];
        const older = entries[i + 1];

        if (newer === undefined || older === undefined) {
            continue;
        }

        if (newer.signal === older.signal) {
            continue;
        }

        if (newer.timestamp < windowStart) {
            // Entries are newest-first, so once a pair falls out of the
            // window every later pair is older still.
            break;
        }

        changes24h += 1;
        transitionIndex ??= i;
    }

    let lastTransition: SignalHistoryLastTransition | null = null;
    let previousDurationHours: number | null = null;
    let previousDurationBounded = false;

    if (transitionIndex !== undefined) {
        const newer = entries[transitionIndex];
        const older = entries[transitionIndex + 1];

        if (newer !== undefined && older !== undefined) {
            lastTransition = {
                from: older.signal,
                to: newer.signal,
                timestamp: newer.timestamp,
            };

            // Previous run: consecutive same-signal records after the
            // transition, going back toward older records.
            const previousSignal = older.signal;
            let previousRun = 0;
            let cursor = transitionIndex + 1;

            while (
                cursor < entries.length &&
                entries[cursor]?.signal === previousSignal
            ) {
                previousRun += 1;
                cursor += 1;
            }

            const previousEnd = entries[transitionIndex + 1];
            const previousStart = entries[transitionIndex + previousRun];

            if (previousEnd !== undefined && previousStart !== undefined) {
                previousDurationHours = runDurationHours(
                    previousEnd.timestamp,
                    previousStart.timestamp,
                );
                previousDurationBounded = cursor < entries.length;
            }
        }
    }

    const oldest = entries[entries.length - 1];

    return {
        currentSignal,
        currentDurationHours:
            runStart === undefined
                ? null
                : runDurationHours(
                    newest.timestamp,
                    runStart.timestamp,
                ),
        currentDurationBounded: currentRun < entries.length,
        changes24h,
        lastTransition,
        previousDurationHours,
        previousDurationBounded,
        sampleHours:
            oldest === undefined
                ? 0
                : runDurationHours(
                    newest.timestamp,
                    oldest.timestamp,
                ),
    };
}
