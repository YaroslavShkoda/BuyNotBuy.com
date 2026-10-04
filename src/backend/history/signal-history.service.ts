import { historyConfig } from '../config/history.config.js';
import { marketConfig } from '../config/market.config.js';
import { configuredVenueFor } from '../market/market.provider.js';
import type {
    BacklogState,
    BacklogStateByMarket,
} from '../observability/bounded-write-buffer.js';
import { createFlushGuard } from '../observability/bounded-write-buffer.js';
import { getSignalHistoryRepository } from './signal-history.repository.js';
import type {
    SignalHistoryEntry,
    SignalHistoryLastTransition,
    SignalHistoryLogger,
    SignalHistorySummary,
} from './signal-history.types.js';
import { createSignalHistoryWriteBuffer } from './signal-history.write-buffer.js';

/**
 * Consecutive failed attempts per buffered entry.
 *
 * A `WeakMap` keyed by the entry object itself, because the entries are re-queued
 * **by identity** — the same object comes back out of `drain()` — and a parallel
 * count keyed by symbol would attribute two markets' attempts to whichever arrived
 * last. Weak so a given-up entry leaves nothing behind.
 */
const attempts = new WeakMap<SignalHistoryEntry, number>();

/**
 * How many times one entry is retried before the process stops trying.
 *
 * Five ticks at the poller's cadence is a few minutes of a database having a bad
 * time, and long past the point where the same statement will start working. The
 * ceiling is not about giving up on the entry — it is about the entry becoming the
 * newest thing in a buffer that drops its oldest, which turns one unwritable row
 * into a slow eviction of rows that would have been written.
 */
const MAX_ATTEMPTS = 5;

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
                // Named, because the two counters below are the process's and not
                // this market's: with a second market running, "buffered: 400"
                // says only that somebody is behind, and the failure being
                // diagnosed is per market — one market, one configured venue, one
                // series. The symbol was in scope the whole time.
                market: entry.symbol,
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
    let failed = 0;
    let givenUp = 0;
    let consecutiveFailures = 0;

    // Every pending entry is attempted, and only the ones that failed go back.
    //
    // **This used to stop at the first failure**, which was a reasonable-looking
    // choice: everything from the failing entry onward is unwritten, so re-queueing
    // the tail discards nothing. What it did not consider is that the buffer held
    // **two markets**. One poisoned entry — a row the database refuses for a reason
    // that has nothing to do with the other series — blocked every entry behind it,
    // including the other market's, on every flush, for ever. A stall that was
    // never retried and never reported, in a mechanism whose whole purpose is not to
    // lose an hour.
    //
    // Continuing is safe because the upsert is guarded by the timestamp:
    // `ON CONFLICT … DO UPDATE … WHERE EXCLUDED.timestamp > signal_history.timestamp`.
    // Writing out of order can only move a row forward, never backward, so there is
    // no ordering to preserve — the tail this loop used to re-queue was unwritten,
    // not *misordered*.
    for (const [index, entry] of pending.entries()) {
        try {
            await getSignalHistoryRepository().record({
                ...entry,
                ...seriesFor(entry.symbol),
            });

            written += 1;
            consecutiveFailures = 0;
            attempts.delete(entry);
        } catch (error) {
            failed += 1;
            consecutiveFailures += 1;

            // **One distinction, and it is the difference between this being right
            // and this being a second way to lose data.**
            //
            // Two failures in a row means the database is not answering, and
            // repeating the same statement for every entry in the buffer once a cycle
            // is hammering. So the tail is handed back untouched and the flush stops.
            //
            // One failure followed by a success means the database is answering and
            // **this row** is the problem: a constraint, a shape, a row it will not
            // take. That row is re-queued with a bounded number of attempts, and the
            // entries behind it are written now — because they are not what is
            // broken, and waiting for them behind it is the stall that kept a second
            // market's history unwritten for ever.
            //
            // **The bound moved from one attempt per flush to two, and that is the
            // price of telling the two apart.** "Nothing written yet" cannot do it: a
            // bad first row and a dead database look identical at index zero, which
            // is the version I wrote first and which stalled the very case it was
            // meant to fix. One extra attempt per cycle, against every hour of a
            // second market's history that never arrives, is a trade worth making
            // and worth writing down rather than discovering later.
            if (consecutiveFailures >= 2) {
                for (const unprocessed of pending.slice(index)) {
                    writeBuffer.push(unprocessed);
                }

                logger?.warn(
                    {
                        event: 'signal_history_flush_failed',
                        // Nothing was written, so the database is the story and the
                        // rest of the queue is untouched — `written: 0` is what makes
                        // that distinction readable in the log.
                        written,
                        failed,
                        buffered: writeBuffer.size,
                        err: error,
                    },
                    'signal_history_flush_failed',
                );

                break;
            }

            // And a bounded number of retries, which the old loop got for free by
            // never getting past the first failure. Re-queued, an entry becomes the
            // **newest** in a buffer that evicts its oldest, so one entry that can
            // never be written would sit there protecting itself while real hours
            // were dropped — a failure that had become the mechanism for losing
            // data, which is the opposite of what a buffer is for.
            const tries = (attempts.get(entry) ?? 0) + 1;

            if (tries >= MAX_ATTEMPTS) {
                attempts.delete(entry);
                givenUp += 1;

                logger?.warn(
                    {
                        event: 'signal_history_entry_given_up',
                        attempts: tries,
                        symbol: entry.symbol,
                        timestamp: entry.timestamp,
                        buffered: writeBuffer.size,
                        err: error,
                    },
                    'signal_history_entry_given_up',
                );

                continue;
            }

            attempts.set(entry, tries);
            writeBuffer.push(entry);
        }
    }

    if (failed > 0) {
        logger?.warn(
            {
                event: 'signal_history_flush_failed',
                failed,
                givenUp,
                written,
                buffered: writeBuffer.size,
            },
            'signal_history_flush_failed',
        );
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

export function signalHistoryBacklog(): BacklogState & {
    byMarket: BacklogStateByMarket;
} {
    return {
        buffered: writeBuffer.size,
        dropped: writeBuffer.droppedCount,
        byMarket: writeBuffer.byMarket,
    };
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
