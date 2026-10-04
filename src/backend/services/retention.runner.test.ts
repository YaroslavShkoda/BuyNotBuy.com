import { describe, expect, it } from 'vitest';
import type { PruneReport } from '../db/retention.js';

import type { RetentionStore } from '../db/retention.store.js';
import { createRetentionRunner } from './retention.runner.js';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

function report(over: Partial<PruneReport> = {}): PruneReport {
    return {
        results: [],
        refused: [],
        totalDeleted: 0,
        totalDurationMs: 0,
        nothingToDo: true,
        ...over,
    };
}

const store = (prune: () => Promise<PruneReport>) => {
    const calls: number[] = [];

    return {
        calls,
        impl: {
            listPolicies: async () => [],
            setPolicy: async () => undefined,
            lastRun: async () => null,
            // Recorded here rather than inside each test's own closure: two of
            // these tests were silently counting nothing, because only the first
            // one had bothered to push.
            prune: async (now: number) => {
                calls.push(now);

                return await prune();
            },
        } satisfies RetentionStore,
    };
};

describe('retention runs on its own clock', () => {
    it('prunes when it is due', async () => {
        const s = store(async () => report({ totalDeleted: 3, nothingToDo: false }));

        const result = await createRetentionRunner(s.impl).maybeRun(NOW);

        expect(result.skipped).toBe(false);
        expect(result.report?.totalDeleted).toBe(3);
        expect(s.calls).toEqual([NOW]);
    });

    it('does not prune again inside the interval', async () => {
        // The poller ticks far more often than a three-year policy can have
        // anything new to delete. Pruning on every tick would mean a DELETE
        // statement every few minutes to discover there is nothing to delete.
        const s = store(async () => report());
        const runner = createRetentionRunner(s.impl, DAY);

        await runner.maybeRun(NOW);
        const second = await runner.maybeRun(NOW + 1_000);

        expect(second.skipped).toBe(true);
        expect(second.report).toBeNull();
        expect(s.calls).toHaveLength(1);
    });

    it('says it skipped, rather than looking like a prune that deleted nothing', async () => {
        // **This distinction is the whole point.** A prune that ran and found
        // nothing, and a prune that never ran, produce identical silence — and
        // a policy that stopped being honoured looks exactly like a policy with
        // nothing to do.
        const s = store(async () => report());
        const runner = createRetentionRunner(s.impl, DAY);

        await runner.maybeRun(NOW);
        const skipped = await runner.maybeRun(NOW + DAY - 1);
        const due = await runner.maybeRun(NOW + DAY);

        expect(skipped.skipped).toBe(true);
        expect(due.skipped).toBe(false);
        expect(s.calls).toHaveLength(2);
    });

    it('does not mark a failed run as done', async () => {
        // Recording the attempt before the work means one failure suppresses the
        // next try for a whole day — and nobody is told, because the only record
        // of it is a timestamp.
        let attempts = 0;
        const s = store(async () => {
            attempts += 1;

            if (attempts === 1) {
                throw new Error('нет соединения');
            }

            return report();
        });
        const runner = createRetentionRunner(s.impl, DAY);

        await expect(runner.maybeRun(NOW)).rejects.toThrow('нет соединения');
        await expect(runner.maybeRun(NOW + 1_000)).resolves.toMatchObject({
            skipped: false,
        });
        expect(attempts).toBe(2);
    });
});
