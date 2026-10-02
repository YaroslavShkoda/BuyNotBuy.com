import { describe, expect, it, vi } from 'vitest';

import {
    createBoundedWriteBuffer,
    createFlushGuard,
} from './bounded-write-buffer.js';

function buffer(maxSize = 3) {
    // The market of a number is the number itself: these tests are about the
    // queue, and one symbol per entry keeps them honest about `byMarket` too.
    return createBoundedWriteBuffer<number>({
        maxSize,
        label: 'test',
        marketOf: (entry) => `M${entry}`,
    });
}

describe('bounded write buffer', () => {
    it('starts empty', () => {
        expect(buffer().size).toBe(0);
        expect(buffer().droppedCount).toBe(0);
    });

    it('hands entries back oldest first', () => {
        const target = buffer(10);

        target.push(1);
        target.push(2);
        target.push(3);

        expect(target.drain()).toEqual([1, 2, 3]);
    });

    it('empties itself when drained', () => {
        const target = buffer(10);

        target.push(1);
        target.drain();

        expect(target.size).toBe(0);
        expect(target.drain()).toEqual([]);
    });

    it('drops the oldest entries when full and counts them', () => {
        const target = buffer(2);

        target.push(1);
        target.push(2);
        target.push(3);

        expect(target.drain()).toEqual([2, 3]);
        expect(target.droppedCount).toBe(1);
    });

    it('counts every drop over a long outage', () => {
        const target = buffer(5);

        for (let index = 0; index < 100; index += 1) {
            target.push(index);
        }

        expect(target.size).toBe(5);
        expect(target.droppedCount).toBe(95);
    });
});

describe('flush guard', () => {
    it('runs the flush when nothing is in flight', async () => {
        const guard = createFlushGuard();
        const flush = vi.fn(async () => 3);

        await expect(guard(flush)).resolves.toBe(3);
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('joins a flush already running instead of starting a second one', async () => {
        const guard = createFlushGuard();
        let release = (): void => {};
        const flush = vi.fn(
            async () =>
                new Promise<number>((resolve) => {
                    release = () => resolve(7);
                }),
        );

        const first = guard(flush);
        const second = guard(flush);

        // Two flushes draining the same array would both write the same
        // entries, and a push arriving between one drain and its re-queue
        // would be replayed against a repository that already accepted it.
        expect(flush).toHaveBeenCalledTimes(1);

        release();
        await expect(first).resolves.toBe(7);
        await expect(second).resolves.toBe(7);
    });

    it('lets a later flush run once the previous one has settled', async () => {
        const guard = createFlushGuard();
        const flush = vi.fn(async () => 1);

        await guard(flush);
        await guard(flush);

        expect(flush).toHaveBeenCalledTimes(2);
    });

    it('releases the guard when the flush throws', async () => {
        const guard = createFlushGuard();
        const failing = vi.fn(async () => {
            throw new Error('database gone');
        });

        await expect(guard(failing)).rejects.toThrow('database gone');
        await expect(guard(failing)).rejects.toThrow('database gone');

        // A guard held forever by a failed flush would turn one transient
        // error into a permanent silent backlog.
        expect(failing).toHaveBeenCalledTimes(2);
    });
});

describe('a buffer that serves more than one market', () => {
    const marketBuffer = (maxSize: number) =>
        createBoundedWriteBuffer<{ symbol: string }>({
            maxSize,
            label: 'test',
            marketOf: (entry) => entry.symbol,
        });

    it('counts each market separately', () => {
        // **The finding.** Both write paths feed one queue from every market, and
        // the counters were process-wide, so "buffered: 400" named a process and
        // not a market — while the failure being diagnosed is per market by
        // construction.
        const queue = marketBuffer(10);

        queue.push({ symbol: 'BTCUSDT' });
        queue.push({ symbol: 'BTCUSDT' });
        queue.push({ symbol: 'ETHUSDT' });

        expect(queue.byMarket).toEqual({
            BTCUSDT: { buffered: 2, dropped: 0 },
            ETHUSDT: { buffered: 1, dropped: 0 },
        });
    });

    it('says which market lost records to a full buffer', () => {
        // The attribution matters more than the count. A full buffer drops the
        // **oldest** entry, so a market in a long outage can evict a healthy
        // market's records — and the hole then appears in a series nobody logged
        // a failure for. Without this the drop counter cannot name either.
        const queue = marketBuffer(2);

        queue.push({ symbol: 'BTCUSDT' });
        queue.push({ symbol: 'BTCUSDT' });
        queue.push({ symbol: 'ETHUSDT' });

        // The third push overflowed a buffer of two, so the oldest — a BTCUSDT
        // entry — was evicted. One BTCUSDT record is gone and one is still held;
        // ETHUSDT is untouched, which is the fact that used to be unavailable.
        expect(queue.byMarket).toEqual({
            BTCUSDT: { buffered: 1, dropped: 1 },
            ETHUSDT: { buffered: 1, dropped: 0 },
        });
        expect(queue.droppedCount).toBe(1);
    });

    it('reads a market as dropped even when nothing of it is left', () => {
        // A market whose every record was evicted still appears, with its drop
        // count. Dropping the key instead would make the worst case — the market
        // that lost the most — the one that disappears from the report.
        const queue = marketBuffer(1);

        queue.push({ symbol: 'BTCUSDT' });
        queue.push({ symbol: 'ETHUSDT' });

        expect(queue.byMarket['BTCUSDT']).toEqual({ buffered: 0, dropped: 1 });
        expect(Object.keys(queue.byMarket).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    it('reports nothing once everything has been written, and keeps every drop', () => {
        // A drain is a success: buffered goes to nothing, and the drop count
        // survives it — because a drop already happened and no later write can
        // undo it. That is why `dropped` is a remembered tally rather than a
        // recount: an evicted entry is gone by the time anyone could count it.
        const queue = marketBuffer(2);

        queue.push({ symbol: 'BTCUSDT' });
        queue.push({ symbol: 'ETHUSDT' });
        queue.push({ symbol: 'SOLUSDT' });

        queue.drain();

        expect(queue.size).toBe(0);
        expect(queue.droppedCount).toBe(1);
        // SOLUSDT evicted BTCUSDT; the tally names who lost, not who filled.
        //
        // ETHUSDT and SOLUSDT are **absent**, not present-and-zero: they hold
        // nothing and have dropped nothing, so there is nothing to say about
        // them. Counting from the queue rather than remembering every market ever
        // seen is what keeps this from becoming a map that only grows — and a
        // permanent `{market="…"} 0` for markets that were fine is noise in a
        // scrape.
        expect(queue.byMarket).toEqual({
            BTCUSDT: { buffered: 0, dropped: 1 },
        });
    });
});
