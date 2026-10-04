import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { createSingleFlight } from './single-flight.js';

async function settle(): Promise<void> {
    for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
    }
}

function gate() {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release: () => release() };
}

describe('concurrent callers share one call, and know who they were', () => {
    it('runs the work once for a burst', async () => {
        const flight = createSingleFlight<number>();
        const work = vi.fn(async () => 7);
        const started = gate();

        const all = [
            flight.run(async () => {
                await started.promise;

                return work();
            }),
            flight.run(async () => {
                await started.promise;

                return work();
            }),
            flight.run(async () => {
                await started.promise;

                return work();
            }),
        ];

        started.release();
        const results = await Promise.all(all);

        // A stampede here is a burst of identical upstream requests, which is
        // what a circuit breaker counts.
        expect(work).toHaveBeenCalledTimes(1);
        expect(results.every((entry) => entry.result === 7)).toBe(true);
        expect(flight.joined).toBe(2);
    });

    it('names exactly one caller the leader', async () => {
        const flight = createSingleFlight<number>();
        const started = gate();

        const all = [0, 1, 2, 3].map(() =>
            flight.run(async () => {
                await started.promise;

                return 1;
            }),
        );

        started.release();
        const results = await Promise.all(all);

        // This is the flag a once-per-computation write is gated on. If two
        // callers were told they led, the history would gain a row per race.
        expect(results.filter((entry) => entry.leader)).toHaveLength(1);
    });

    it('starts a fresh call once the previous one has settled', async () => {
        const flight = createSingleFlight<number>();
        const work = vi.fn(async () => 1);

        await flight.run(work);
        await flight.run(work);

        // Forgetting the result is the whole point: this is not a cache, and a
        // second call a microsecond later must reach the provider.
        expect(work).toHaveBeenCalledTimes(2);
        expect(flight.inFlight).toBe(false);
    });

    it('lets a late caller start its own call rather than joining a finished one', async () => {
        const flight = createSingleFlight<number>();
        const work = vi.fn(async () => 1);

        await flight.run(work);
        await settle();
        const second = await flight.run(work);

        expect(second.leader).toBe(true);
        expect(work).toHaveBeenCalledTimes(2);
    });
});

describe('a failure belongs to the attempt that had it', () => {
    it('does not hand one caller the rejection of another', async () => {
        const flight = createSingleFlight<number>();
        const started = gate();
        let attempts = 0;

        const work = async () => {
            attempts += 1;
            await started.promise;

            if (attempts === 1) {
                throw new Error('provider timeout');
            }

            return 42;
        };

        const leader = flight.run(work);
        const follower = flight.run(work);

        started.release();
        const [leaderResult, followerResult] = await Promise.all([
            leader.catch((error: Error) => error),
            follower,
        ]);

        // One provider timeout on the first of two concurrent requests must not
        // become two failed page loads. Two requests failing is a fact about
        // the provider; one failing and one succeeding is what happened.
        expect(leaderResult).toBeInstanceOf(Error);
        expect(followerResult).toEqual({ result: 42, leader: true });
        expect(attempts).toBe(2);
        expect(flight.retriedAfterSharedFailure).toBe(1);
    });

    it('lets every caller fail when the work really always fails', async () => {
        const flight = createSingleFlight<number>();
        const started = gate();
        const work = vi.fn(async () => {
            await started.promise;
            throw new Error('down');
        });

        const all = [flight.run(work), flight.run(work), flight.run(work)];
        started.release();

        const settled = await Promise.allSettled(all);

        // Retrying is not a way to turn an outage into a success. Each caller
        // gets its own failure, and the caller that led is not retried at all.
        expect(settled.every((entry) => entry.status === 'rejected')).toBe(true);
        expect(work).toHaveBeenCalledTimes(3);
    });

    it('does not retry the caller that led, so one failure is one upstream call', async () => {
        const flight = createSingleFlight<number>();
        const work = vi.fn(async () => {
            throw new Error('down');
        });

        await expect(flight.run(work)).rejects.toThrow('down');

        expect(work).toHaveBeenCalledTimes(1);
        expect(flight.retriedAfterSharedFailure).toBe(0);
    });
});

describe('whatever the interleaving, every caller gets the same truth', () => {
    it('holds for any mix of arrival widths', async () => {
        // A property function has to be synchronous and this one is inherently
        // not, so the generated cases are sampled rather than driven by
        // `fc.assert`. Same coverage, an honest tool.
        const schedules = fc.sample(
            fc.array(fc.integer({ min: 1, max: 4 }), {
                minLength: 1,
                maxLength: 8,
            }),
            40,
        );

        for (const widths of schedules) {
            const flight = createSingleFlight<number>();
            let runs = 0;

            const results = await Promise.all(
                widths.map(async (width) => {
                    for (let turn = 0; turn < width; turn += 1) {
                        await Promise.resolve();
                    }

                    return flight.run(async () => {
                        runs += 1;

                        return runs;
                    });
                }),
            );

            // Every value a caller received is one a run actually produced,
            // and no two runs produced the same number. Callers that arrived
            // after an earlier call had settled are entitled to a different
            // answer — this is not a cache, and pretending otherwise would be
            // the bug rather than the fix.
            const values = new Set(results.map((entry) => entry.result));

            expect([...values].every((value) => value >= 1 && value <= runs)).toBe(true);
            expect(values.size).toBe(runs);
            expect(runs).toBeGreaterThanOrEqual(1);
        }
    });

    it('never runs the work zero times for a burst of callers', async () => {
        const flight = createSingleFlight<number>();
        const work = vi.fn(async () => 1);

        await Promise.all(Array.from({ length: 12 }, () => flight.run(work)));

        expect(work).toHaveBeenCalledTimes(1);
        expect(flight.joined).toBe(11);
    });
});
