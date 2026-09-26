import { describe, expect, it } from 'vitest';

import { createSignalHistoryWriteBuffer } from './signal-history.write-buffer.js';

import type { SignalHistoryEntry } from './signal-history.types.js';

function entry(
    overrides: Partial<SignalHistoryEntry> = {},
): SignalHistoryEntry {
    return {
        timestamp: 1_737_950_400_000,
        symbol: 'BTCUSDT',
        signal: 'SHORT',
        consensus: 67,
        price: 100_000,
        ...overrides,
    };
}

describe('signal history write buffer', () => {
    it('starts empty', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 3 });

        expect(buffer.size).toBe(0);
        expect(buffer.droppedCount).toBe(0);
    });

    it('hands entries back oldest first', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 10 });

        buffer.push(entry({ price: 1 }));
        buffer.push(entry({ price: 2 }));
        buffer.push(entry({ price: 3 }));

        expect(buffer.drain().map((item) => item.price)).toEqual([1, 2, 3]);
    });

    it('empties itself when drained', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 10 });

        buffer.push(entry());

        expect(buffer.drain()).toHaveLength(1);
        expect(buffer.size).toBe(0);
        expect(buffer.drain()).toEqual([]);
    });

    it('drops the oldest entries when it is full', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 2 });

        buffer.push(entry({ price: 1 }));
        buffer.push(entry({ price: 2 }));
        buffer.push(entry({ price: 3 }));

        // A long outage must not become unbounded memory growth, and the most
        // recent state is the one worth keeping.
        expect(buffer.drain().map((item) => item.price)).toEqual([2, 3]);
        expect(buffer.size).toBe(0);
    });

    it('reports how many entries were lost', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 1 });

        buffer.push(entry({ price: 1 }));
        buffer.push(entry({ price: 2 }));
        buffer.push(entry({ price: 3 }));

        // Losing history silently would make a gap read as "the signal was
        // stable", which is the wrong conclusion from missing data.
        expect(buffer.droppedCount).toBe(2);
    });

    it('counts every drop over a long outage', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 5 });

        for (let index = 0; index < 100; index += 1) {
            buffer.push(entry({ price: index }));
        }

        expect(buffer.size).toBe(5);
        expect(buffer.droppedCount).toBe(95);
    });

    it('can be emptied without replaying anything', () => {
        const buffer = createSignalHistoryWriteBuffer({ maxSize: 5 });

        buffer.push(entry({ price: 1 }));
        buffer.clear();

        expect(buffer.size).toBe(0);
        expect(buffer.drain()).toEqual([]);
    });
});
