/**
 * A bounded, first-in-first-out holding area for records that could not be
 * written.
 *
 * Shared by the two write paths that exist to be fail-open — signal history and
 * per-indicator votes — because the reason for buffering is the same in both:
 * a persistence failure must never propagate into the market analysis path, and
 * dropping the record outright leaves a hole that a later summary reads as
 * "nothing changed", which is the one conclusion missing data must not be
 * allowed to produce.
 *
 * Bounded on purpose: a long outage must not become unbounded memory growth,
 * and the oldest entries are the least useful to keep.
 *
 * **It lives here rather than in `history/`, and it never did belong there.**
 * Its own first paragraph says it is shared by two write paths, one of which is
 * in `indicators/`, and `indicators` is declared a leaf that may import
 * nothing. While the file sat in `history/`, that made the second write path
 * commit a layering violation every time it used the thing built to help it:
 * the shared utility was misfiled as one consumer's domain, and the guard was
 * pointing at a true statement about the wrong file.
 *
 * `observability` is where the layer table puts things everything may count
 * through, and that is what this is: a failure absorbed on purpose so it can be
 * counted later and drained. `BacklogState` came with it, because it is the two
 * counters below under different names — it was declared in
 * `history/signal-history.service.ts` and used by `indicators/` for a shape
 * that describes a buffer, so a second layer was reaching into a service to
 * name the state of an object it did not own.
 */
export interface BoundedWriteBuffer<T> {
    push(entry: T): void;
    /** Oldest first, removed from the buffer as they are returned. */
    drain(): T[];
    readonly size: number;
    /** Entries dropped because the buffer was full, over the buffer's lifetime. */
    readonly droppedCount: number;
    clear(): void;
}

export interface BoundedWriteBufferOptions {
    /** Hard ceiling on buffered entries; oldest are dropped past this. */
    maxSize: number;
    /** Which record this buffer holds, for the operator reading a counter. */
    label: string;
}

/**
 * What an operator reads off a backlog.
 *
 * Declared beside the buffer rather than in the service that first needed it,
 * because it is the buffer's own `size` and `droppedCount` under the names the
 * health endpoint has always used. The two counter names are not the same on
 * purpose: `buffered` is now, `dropped` is since the process started, and a
 * reader is meant to be able to tell that.
 */
export interface BacklogState {
    /** Entries held for a retry. */
    buffered: number;
    /** Entries lost to an overfull buffer since the process started. */
    dropped: number;
}

export function createBoundedWriteBuffer<T>(
    options: BoundedWriteBufferOptions,
): BoundedWriteBuffer<T> {
    const entries: T[] = [];

    let dropped = 0;

    return {
        push(entry: T): void {
            entries.push(entry);

            while (entries.length > options.maxSize) {
                entries.shift();
                dropped += 1;
            }
        },

        drain(): T[] {
            return entries.splice(0, entries.length);
        },

        get size(): number {
            return entries.length;
        },

        get droppedCount(): number {
            return dropped;
        },

        clear(): void {
            entries.length = 0;
        },
    };
}

/**
 * Runs at most one flush at a time, and hands concurrent callers the same run.
 *
 * Two flushes racing each other would drain the buffer into local variables and
 * then both write the same entries, and — worse — a push arriving between one
 * drain and its failure re-queue would be replayed against a repository that
 * had already accepted it. The write is idempotent, so the duplicate is
 * harmless, but the interleaving is not something to reason about at three in
 * the morning.
 */
export interface FlushGuard {
    /** Runs the given flush, or joins the one already running. */
    (flush: () => Promise<number>): Promise<number>;
}

export function createFlushGuard(): FlushGuard {
    let inFlight: Promise<number> | null = null;

    return (flush: () => Promise<number>): Promise<number> => {
        if (inFlight !== null) {
            return inFlight;
        }

        inFlight = flush().finally(() => {
            inFlight = null;
        });

        return inFlight;
    };
}
