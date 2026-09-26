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
