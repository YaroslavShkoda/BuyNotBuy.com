import { createBoundedWriteBuffer } from '../observability/bounded-write-buffer.js';

import type { BoundedWriteBuffer } from '../observability/bounded-write-buffer.js';
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
 * The mechanism is the shared bounded buffer: the indicator vote store needs
 * exactly this and was, until now, losing records instead of holding them.
 */
export function createSignalHistoryWriteBuffer(
    options: SignalHistoryWriteBufferOptions,
): SignalHistoryWriteBuffer {
    return createBoundedWriteBuffer<SignalHistoryEntry>({
        maxSize: options.maxSize,
        label: 'signal_history',
    }) as BoundedWriteBuffer<SignalHistoryEntry>;
}
