import { marketConfig } from '../config/market.config.js';
import { configuredVenueFor } from '../market/market.provider.js';
import { historyConfig } from '../config/history.config.js';

import { getSignalHistoryRepository } from './signal-history.repository.js';
import { createSignalHistoryWriteBuffer } from './signal-history.write-buffer.js';
import { createFlushGuard } from '../observability/bounded-write-buffer.js';

import type { BacklogState } from '../observability/bounded-write-buffer.js';
import type {
    SignalHistoryEntry,
    SignalHistoryLastTransition,
    SignalHistoryLogger,
    SignalHistorySummary,
} from './signal-history.types.js';

const writeBuffer = createSignalHistoryWriteBuffer({
    maxSize: historyConfig.maxBufferedEntries,
});

/**
 * At most one flush at a time.
 *
 * The backlog is drained into a local array, so two concurrent flushes would
 * both be writing while a third push lands in the array one of them is about
 * to re-queue. A single guard turns three interleavings into one.
 */
const runFlush = createFlushGuard();

/**
 * Re-exported so the health endpoint and its tests keep one import for "the
 * shape of a backlog", wherever the buffer that produces it happens to live.
 * The declaration itself is in `observability/`, beside the buffer.
 */
export type { BacklogState } from '../observability/bounded-write-buffer.js';

/**
 * How often retention may run, per series.
 *
 * Retention used to run inside every write. With the write happening on each
 * page load and once a minute from the poller, that is a full scan per request
 * to delete at most one row — and in the database it had never deleted a row
 * at all, so the cost was pure and the benefit zero. A cadence keeps the
 * guarantee that the table is bounded while making the cost proportional to
 * how fast the table actually grows.
 *
 * **Per series, not per process.** It was one timestamp for the whole process,
 * and the thing it gates is per-symbol: `trimRetention(symbol)` deletes
 * `WHERE symbol = $1 AND provider = $2 AND interval = $3`. So the first market
 * in `marketConfig.symbols` consumed the window on every pass, and every other
 * market's `signal_history` returned 0 and was never trimmed at all — growing by
 * one row an hour until the global 1095-day prune, which is the only other thing
 * that ever removes them.
 *
 * Per series is also the shape of the cost the comment above is asking for: "a
 * cadence keeps the guarantee that the table is bounded" is a promise about each
 * table, and one window over several tables kept the guarantee for one of them.
 */
const RETENTION_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * The last trim attempt per symbol.
 *
 * A `Map` rather than a number because the window is a property of a series, and
 * one variable can only hold the property of one. Bounded by the number of
 * markets the process has ever written, which is the number of markets it was
 * configured with.
 */
const lastTrimAt = new Map<string, number>();

/**
 * Enforces the retention limit, at most once per interval per series.
 *
 * A failure is swallowed: retention is housekeeping, and refusing to record
 * history because the trimming statement was slow would trade a bounded table
 * for a missing hour. The next attempt comes round regardless.
 *
 * The window is consumed before the attempt, not after, so a database that is
 * slow or down costs one missed trim and not one trim per write: the alternative
 * is a failing trim on every successful write, which is the cost the cadence
 * exists to avoid, arriving through the failure path.
 */
async function maybeTrimRetention(
    symbol: string,
    now: number = Date.now(),
): Promise<number> {
    const last = lastTrimAt.get(symbol);

    if (last !== undefined && now - last < RETENTION_MIN_INTERVAL_MS) {
        return 0;
    }

    lastTrimAt.set(symbol, now);

    try {
        return await getSignalHistoryRepository().trimRetention(
            symbol,
            seriesFor(symbol),
        );
    } catch {
        return 0;
    }
}

// History is a non-critical subsystem: a persistence failure must never
// propagate into the market analysis path, so this wrapper is fail-open
// by contract and never rejects. A failed write is buffered rather than
// dropped, so a momentary database problem leaves no hole in the record.
//
// It still returns a promise, and the caller is expected to await it: a
// fire-and-forget write against an asynchronous driver would turn every
// database failure into an unhandled rejection, which is the opposite of
// fail-open.
/**
 * The series a market's history is filed under, resolved once.
 *
 * **This was the gap round 89 left.** That round fixed `configuredSeries`, and the
 * three tables that take their key from it — candles, signal state, outcomes — were
 * corrected. History did not: `seriesOf` in the repository defaulted the venue to
 * `marketConfig.provider`, and the only production writer never set a venue on the
 * entry, so every market's history was filed under the primary's name while every
 * other table named the right one.
 *
 * Nothing collided, because `symbol` is in the primary key. So no test failed and no
 * row was lost — the table simply claimed binance-sourced prices came from binance
 * when they came from bitget, and a future join on `(symbol, provider, interval)`
 * between history and outcomes would have matched nothing for the second market.
 *
 * **Resolved here rather than in the repository** because both sides need it. The
 * write and the read must agree on the series or `/api/signal-history?instrument=`
 * reads a series nothing was written to — and the two live in different functions.
 * The repository keeps accepting an explicit series, which is where the shape for
 * this already existed.
 *
 * The **configured** venue, not the answering one, for the reason round 89 gave: a
 * key built from the answering venue would split one market's history across two
 * series every time the primary failed over.
 */
function seriesFor(symbol: string): { provider: string; interval: string } {
    return {
        provider: configuredVenueFor(symbol),
        interval: marketConfig.candleInterval,
    };
}

export async function recordSignalHistory(
    entry: SignalHistoryEntry,
    logger?: SignalHistoryLogger,
): Promise<void> {
    try {
        await getSignalHistoryRepository().record({
                ...entry,
                ...seriesFor(entry.symbol),
            });

        // The upsert succeeded, so the write path is healthy and this is a
        // good moment to do the housekeeping against a database that just
        // answered.
        await maybeTrimRetention(entry.symbol);
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

        // A retry on the next failure, or on the next poll, is enough when
        // something is ticking. Nothing ticks when the poller is off, and the
        // buffer would then fill and silently overwrite its own oldest hours
        // — turning a "retry later" mechanism into a lossy ring buffer.
        if (writeBuffer.size >= historyConfig.maxBufferedEntries) {
            await flushSignalHistoryBacklog(logger);
        }
    }
}

async function writeBacklog(logger?: SignalHistoryLogger): Promise<number> {
    if (writeBuffer.size === 0) {
        return 0;
    }

    // Drained once, then handed back wholesale on failure. Peeking instead
    // would mean a `shift` that throws has already lost the entry.
    const pending = writeBuffer.drain();

    let written = 0;

    for (const [index, entry] of pending.entries()) {
        try {
            await getSignalHistoryRepository().record({
                ...entry,
                ...seriesFor(entry.symbol),
            });
            written += 1;
        } catch (error) {
            // Everything from the failing entry onwards is still unwritten.
            // Pushing back only the entry that failed — and stopping there —
            // would discard the rest of the queue with no write and no count,
            // which is exactly the permanent hole in the record the buffer
            // exists to prevent. And the hole would be invisible: a gap in a
            // stability metric reads as "the signal did not change".
            for (const unprocessed of pending.slice(index)) {
                writeBuffer.push(unprocessed);
            }

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

/**
 * Retries everything that failed to write earlier.
 *
 * Entries are removed from the buffer as they are handed to the repository, so
 * a failure part-way through leaves the remaining ones queued for the next
 * attempt instead of replaying the same prefix forever. The signal is recorded
 * once per hour, so a duplicate write is idempotent anyway.
 *
 * Runs at most once at a time; a concurrent caller joins the run in progress
 * rather than starting a second one over the same array.
 */
export function flushSignalHistoryBacklog(
    logger?: SignalHistoryLogger,
): Promise<number> {
    return runFlush(() => writeBacklog(logger));
}

export function getSignalHistoryBacklogSize(): number {
    return writeBuffer.size;
}

export function signalHistoryBacklog(): BacklogState {
    return { buffered: writeBuffer.size, dropped: writeBuffer.droppedCount };
}

/**
 * The recorded history of **one market**.
 *
 * It took no market and read `marketConfig.symbol`, so a process observing two
 * markets published, snapshotted and settled both every minute — and answered this
 * question about one of them. Nothing failed: the response was a full, well-formed
 * history with real numbers, describing BTCUSDT when the caller had never asked
 * about a market at all.
 *
 * Optional, defaulting to the configured market, so the call sites that mean "the
 * one this deployment is about" keep reading the way they read — and so the frozen
 * route's default behaviour is unchanged for a client that names nothing.
 */
export async function getSignalHistory(
    limit: number,
    before?: number,
    symbol: string = marketConfig.symbol,
): Promise<SignalHistoryEntry[]> {
    return getSignalHistoryRepository().list(symbol, limit, before, seriesFor(symbol));
}

const HOUR_MS = 3_600_000;

/** The window `changes24h` actually covers. */
const CHANGES_WINDOW_MS = 24 * HOUR_MS;

const EMPTY_SUMMARY: SignalHistorySummary = {
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
};

/** Records are bucketed hourly, so a jump larger than this is a hole. */
const BUCKET_MS = 3_600_000;

function isGap(newer: number, older: number): boolean {
    return newer - older > BUCKET_MS + BUCKET_MS / 2;
}

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
 *   - `currentObservedHours` and `currentGaps` say how densely that span was
 *     sampled, so an elapsed duration spanning a hole is not read as a
 *     continuously observed one.
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

    // How much of the current run was actually looked at, and how much of it
    // is missing. `currentDurationHours` above measures the span; these two
    // say how densely that span was sampled, which is the difference between
    // "held for 40 hours" and "held for 40 hours, 38 of which were recorded".
    let currentGaps = 0;

    for (let index = 1; index < currentRun; index += 1) {
        const newer = entries[index - 1];
        const older = entries[index];

        if (
            newer !== undefined &&
            older !== undefined &&
            isGap(newer.timestamp, older.timestamp)
        ) {
            currentGaps += 1;
        }
    }

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
        currentObservedHours: currentRun,
        currentGaps,
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
