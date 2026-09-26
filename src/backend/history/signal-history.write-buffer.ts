import type { SignalHistoryEntry } from './signal-history.types.js';

export interface SignalHistoryWriteBufferOptions {
    /** Hard ceiling on buffered entries; oldest are dropped past this. */
    maxSize: number;
    now?: () => number;
}

export interface SignalHistoryWriteBuffer {
    push(entry: SignalHistoryEntry): void;
    /** Oldest first, removed from the buffer as they are returned. */
    drain(): SignalHistoryEntry[];
    readonly size: number;
    /** Entries dropped because the buffer was full. */
    readonly droppedCount: number;
    clear(): void;
}

/**
 * Holds signal snapshots that could not be written.
 *
 * A history write failing is almost always transient — a locked file, a full
 * disk, a database briefly held by a backup. Dropping the entry would leave a
 * permanent hole in the record, and a hole in a stability metric reads as
 * "the signal was stable", which is exactly the wrong thing to conclude from
 * missing data.
 *
 * The buffer is bounded: a long outage must not turn into unbounded memory
 * growth, and the oldest entries are the least useful to keep.
 */
export function createSignalHistoryWriteBuffer(
    options: SignalHistoryWriteBufferOptions,
): SignalHistoryWriteBuffer {
    const entries: SignalHistoryEntry[] = [];

    let dropped = 0;

    return {
        push(entry: SignalHistoryEntry): void {
            entries.push(entry);

            while (entries.length > options.maxSize) {
                entries.shift();
                dropped += 1;
            }
        },

        drain(): SignalHistoryEntry[] {
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
