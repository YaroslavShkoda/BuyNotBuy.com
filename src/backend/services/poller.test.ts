import { describe, expect, it, vi } from 'vitest';

import { startPoller } from './poller.js';

function silentLogger() {
    return {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    };
}

/** Lets every pending microtask chain settle. */
async function settle(): Promise<void> {
    for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function manualTimers() {
    let nextHandle = 1;
    const pending = new Map<number, () => void>();

    return {
        setTimer: (handler: () => void) => {
            const handle = nextHandle;
            nextHandle += 1;
            pending.set(handle, handler);

            return handle;
        },
        clearTimer: (handle: unknown) => {
            pending.delete(handle as number);
        },
        /** Fires every timer currently scheduled. */
        async tick() {
            const due = [...pending.values()];
            pending.clear();

            for (const handler of due) {
                handler();
            }

            await settle();
        },
        get pendingCount() {
            return pending.size;
        },
    };
}

/**
 * Starts a poller and lets the first cycle finish.
 *
 * The first cycle runs on construction, so without settling, its follow-up
 * timer is not registered yet and the first tick would find nothing to fire.
 */
async function startAndSettle(options: Parameters<typeof startPoller>[0]) {
    const poller = startPoller(options);

    await settle();

    return poller;
}

describe('poller', () => {
    it('runs once immediately so a fresh service is warm straight away', async () => {
        const timers = manualTimers();
        const run = vi.fn(async () => undefined);

        const poller = await startAndSettle({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        expect(run).toHaveBeenCalledTimes(1);

        await poller.stop();
    });

    it('keeps running on its interval', async () => {
        const timers = manualTimers();
        const run = vi.fn(async () => undefined);

        const poller = await startAndSettle({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        await timers.tick();
        await timers.tick();
        await timers.tick();

        expect(run).toHaveBeenCalledTimes(4);

        await poller.stop();
    });

    it('never overlaps two cycles', async () => {
        const timers = manualTimers();

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        let started = 0;

        const run = vi.fn(async () => {
            started += 1;
            await gate;
        });

        const poller = startPoller({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        // Two ticks while the first cycle is still blocked.
        await timers.tick();
        await timers.tick();
        await timers.tick();

        // A slow provider must never stack up a queue of duplicate analyses.
        expect(started).toBe(1);
        expect(run).toHaveBeenCalledTimes(1);

        release();
        await poller.stop();
    });

    it('resumes on the next tick after a slow cycle finishes', async () => {
        const timers = manualTimers();

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const run = vi.fn(async () => {
            await gate;
        });

        const poller = startPoller({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        await timers.tick();

        release();
        await settle();

        await timers.tick();

        expect(run).toHaveBeenCalledTimes(2);

        await poller.stop();
    });

    it('survives a failing cycle and keeps ticking', async () => {
        const timers = manualTimers();
        const logger = silentLogger();
        const run = vi.fn(async () => {
            throw new Error('provider unavailable');
        });

        const poller = await startAndSettle({
            intervalMs: 1000,
            run,
            logger,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        await timers.tick();
        await timers.tick();

        // The poller exists precisely so nobody is watching when the provider
        // is down; it must survive that and try again.
        expect(run).toHaveBeenCalledTimes(3);
        expect(logger.error).toHaveBeenCalledTimes(3);

        await poller.stop();
    });

    it('stops scheduling after stop', async () => {
        const timers = manualTimers();
        const run = vi.fn(async () => undefined);

        const poller = startPoller({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        await poller.stop();

        expect(poller.isRunning).toBe(false);
        expect(timers.pendingCount).toBe(0);

        await timers.tick();

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('waits for the running cycle before reporting it stopped', async () => {
        const timers = manualTimers();

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        let finished = false;

        const poller = startPoller({
            intervalMs: 1000,
            run: async () => {
                await gate;
                finished = true;
            },
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        let stopped = false;

        const stopping = poller.stop().then(() => {
            stopped = true;
        });

        await Promise.resolve();

        // Returning before the cycle ends would let shutdown close the
        // database out from under an open write.
        expect(stopped).toBe(false);

        release();
        await stopping;

        expect(stopped).toBe(true);
        expect(finished).toBe(true);
    });

    it('counts every cycle it attempted', async () => {
        const timers = manualTimers();

        const poller = await startAndSettle({
            intervalMs: 1000,
            run: async () => {
                throw new Error('nope');
            },
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        await timers.tick();

        expect(poller.completedRuns).toBe(2);

        await poller.stop();
    });
});
