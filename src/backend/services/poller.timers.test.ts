import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { startPoller } from './poller.js';

/**
 * What the poller's scheduling structure actually guarantees.
 *
 * The overlap guard reads `inFlight !== null` when a tick arrives, and the
 * poller schedules a tick in exactly one place: the `.finally` of a cycle,
 * which has already set `inFlight = null`. So no timer ever exists while work
 * is in flight, and the guard is never true. Overlap is prevented — not by the
 * guard, but by there being nothing to overlap with.
 *
 * That is worth pinning rather than assuming, because the guard is written as
 * though it were the thing doing the work. If somebody later moves the
 * scheduling out of the `.finally` — to make the interval mean "every N ms"
 * rather than "N ms after the last cycle finished" — the guard becomes load
 * bearing silently, and the first test to notice would be one about a doubled
 * analysis cycle rather than one about scheduling.
 *
 * The generated timings are sampled rather than passed to `fc.assert`, because
 * a property function has to be synchronous and this one is inherently not.
 */

function silentLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

async function settle(): Promise<void> {
    for (let index = 0; index < 12; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function countingTimers() {
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
        /**
         * Fires at most `limit` scheduled timers, one at a time, leaving the
         * rest. Bounded on purpose: every tick schedules another one, so an
         * unbounded drain never finishes and the failure it reports is a
         * timeout rather than the thing being looked for.
         */
        async fireUpTo(limit: number): Promise<number> {
            let fired = 0;

            while (fired < limit) {
                const first = [...pending.entries()][0];

                if (first === undefined) {
                    return fired;
                }

                const [handle, handler] = first;
                pending.delete(handle);
                handler();
                fired += 1;
                await settle();
            }

            return fired;
        },
        get pendingCount() {
            return pending.size;
        },
    };
}

describe('a timer never exists while a cycle is in flight', () => {
    it('holds however slow the cycle is, and however many ticks pass', async () => {
        const schedules = fc.sample(
            fc.array(fc.integer({ min: 0, max: 6 }), {
                minLength: 1,
                maxLength: 12,
            }),
            20,
        );

        for (const delays of schedules) {
            const timers = countingTimers();
            const logger = silentLogger();
            let cursor = -1;
            let concurrent = 0;
            let peak = 0;

            const poller = startPoller({
                intervalMs: 1000,
                // Each cycle yields as many microtask turns as the case asks
                // for, which is the closest a test gets to a cycle that is
                // slow for a reason other than a promise it is waiting on.
                run: async () => {
                    concurrent += 1;
                    peak = Math.max(peak, concurrent);

                    for (let turn = 0; turn < (delays[cursor] ?? 0); turn += 1) {
                        await Promise.resolve();
                    }

                    cursor += 1;
                    concurrent -= 1;
                },
                logger,
                setTimer: timers.setTimer,
                clearTimer: timers.clearTimer,
            });

            await settle();
            await timers.fireUpTo(8);
            await poller.stop();

            expect(peak).toBe(1);
            expect(logger.warn).not.toHaveBeenCalled();
            expect(timers.pendingCount).toBe(0);
        }
    });

    it('leaves exactly one timer scheduled between cycles, never two', async () => {
        const timers = countingTimers();
        let runs = 0;

        const poller = startPoller({
            intervalMs: 1000,
            run: async () => {
                runs += 1;
                await Promise.resolve();
            },
            logger: silentLogger(),
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        for (let round = 0; round < 6; round += 1) {
            await settle();

            // Two timers for one loop would double the analysis rate and leave
            // one of them uncancellable at shutdown.
            expect(timers.pendingCount).toBe(1);
            await timers.fireUpTo(1);
        }

        expect(runs).toBeGreaterThan(1);

        await poller.stop();
        expect(timers.pendingCount).toBe(0);
    });

    it('reschedules after a failure exactly as it does after a success', async () => {
        const timers = countingTimers();
        const logger = silentLogger();
        let attempts = 0;

        const poller = startPoller({
            intervalMs: 1000,
            run: async () => {
                attempts += 1;
                throw new Error('provider unavailable');
            },
            logger,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });

        await settle();
        expect(timers.pendingCount).toBe(1);

        // The poller exists precisely so nobody is watching when the provider
        // is down; a failure that stopped the schedule would turn a provider
        // outage into permanent silence.
        await timers.fireUpTo(3);
        expect(attempts).toBeGreaterThan(1);
        expect(timers.pendingCount).toBe(1);

        await poller.stop();
    });
});
