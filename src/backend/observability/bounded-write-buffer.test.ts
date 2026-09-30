import { describe, expect, it, vi } from 'vitest';

import {
    createBoundedWriteBuffer,
    createFlushGuard,
} from './bounded-write-buffer.js';

function buffer(maxSize = 3) {
    return createBoundedWriteBuffer<number>({ maxSize, label: 'test' });
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
