import { describe, expect, it, vi } from 'vitest';

import { createSingleFlight } from '../observability/single-flight.js';
import { startPoller } from './poller.js';

/**
 * The three things the roadmap asks a poller and a cache to be, checked
 * through the parts that actually run.
 *
 * The single-flight tests here are about the contract as the analysis service
 * uses it — one computation, one history write, one telemetry line per caller
 * — rather than about the primitive, which is tested on its own. A primitive
 * test cannot tell you that the history is written once; only a call through
 * the real code can.
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
        async fireUpTo(limit: number): Promise<void> {
            let fired = 0;

            while (fired < limit) {
                const first = [...pending.entries()][0];

                if (first === undefined) {
                    return;
                }

                const [handle, handler] = first;
                pending.delete(handle);
                handler();
                fired += 1;
                await settle();
            }
        },
        get pendingCount() {
            return pending.size;
        },
    };
}

describe('one history row per computation, however many requests asked', () => {
    it('writes once for a burst and logs once per caller', async () => {
        // The shape the analysis service uses: a shared computation, a write
        // gated on leadership, a telemetry line per caller.
        const flight = createSingleFlight<{ signal: string }>();
        const started = { release: () => {} };
        const gate = new Promise<void>((resolve) => {
            started.release = resolve;
        });

        const history = vi.fn();
        const loggers = Array.from({ length: 10 }, () => ({ info: vi.fn() }));

        const all = loggers.map((logger) =>
            flight.run(async () => {
                await gate;

                return { signal: 'LONG' };
            }).then(({ result, leader }) => {
                logger.info({ signal: result.signal }, 'completed');

                if (leader) {
                    history(result.signal);
                }

                return result;
            }),
        );

        started.release();
        await Promise.all(all);

        // Ten page loads together is one hour of history, not ten. A history
        // that says the market held still ten times is then measured against
        // outcomes as though it were true.
        expect(history).toHaveBeenCalledTimes(1);

        // And ten requests are ten requests: each still gets its own line.
        for (const logger of loggers) {
            expect(logger.info).toHaveBeenCalledTimes(1);
        }
    });
});

describe('a burst does not become a second provider call after it settles', () => {
    it('keeps one in-flight request and forgets it the moment it lands', async () => {
        const flight = createSingleFlight<string>();
        const calls = vi.fn(async () => 'reading');
        const started = { release: () => {} };
        const gate = new Promise<void>((resolve) => {
            started.release = resolve;
        });

        const burst = Array.from({ length: 6 }, () =>
            flight.run(async () => {
                await gate;

                return calls();
            }),
        );

        expect(flight.inFlight).toBe(true);

        started.release();
        await Promise.all(burst);

        expect(calls).toHaveBeenCalledTimes(1);

        // Forgetting is the point. A single flight that remembered its result
        // would be a cache wearing the wrong name, and a price served from it
        // would be a second reading of the market published as a live one.
        expect(flight.inFlight).toBe(false);

        const later = await flight.run(calls);
        expect(later.leader).toBe(true);
        expect(calls).toHaveBeenCalledTimes(2);
    });
});

describe('the poller survives a restart without leaving the old loop running', () => {
    it('stops the previous poller before the next one starts', async () => {
        const first = countingTimers();
        const second = countingTimers();
        const run = vi.fn(async () => undefined);

        const before = startPoller({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: first.setTimer,
            clearTimer: first.clearTimer,
        });

        await settle();
        expect(first.pendingCount).toBe(1);

        // A restart that forgot to stop the old poller would leave two loops
        // writing history for the same hour.
        await before.stop();

        const after = startPoller({
            intervalMs: 1000,
            run,
            logger: silentLogger(),
            setTimer: second.setTimer,
            clearTimer: second.clearTimer,
        });

        await settle();

        expect(first.pendingCount).toBe(0);
        expect(second.pendingCount).toBe(1);

        await after.stop();
        expect(second.pendingCount).toBe(0);
    });
});
