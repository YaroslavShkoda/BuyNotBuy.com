import type { RetentionStore } from '../db/retention.store.js';
import type { PruneReport } from '../db/retention.js';

/**
 * Retention, on a clock rather than on every cycle.
 *
 * **Why not every cycle.** Pruning is the only destructive thing the system
 * does. Running it on the poll timer would mean a DELETE statement every few
 * minutes to discover there is nothing to delete, and a pruner that runs too
 * often is a pruner whose failures are hard to tell apart from its successes.
 *
 * **Why a day.** The shortest policy keeps three years. Running once a day costs
 * one round trip and cannot delete anything a minute of extra running would not
 * have deleted anyway.
 */
export interface RetentionRunner {
    /**
     * Prunes if it is due, and says which of the two things happened.
     *
     * `skipped` is part of the answer rather than a null: a caller that cannot
     * tell "not due yet" from "due, ran, deleted nothing" will log the first as
     * the second, and then a policy that stopped being honoured would look like a
     * policy with nothing to do.
     */
    maybeRun(now: number): Promise<{ skipped: boolean; report: PruneReport | null }>;
}

/**
 * The store is injected, not imported, and that is a layering rule rather than
 * a style choice. `retention.store.ts` takes the database the same way for the
 * same reason — and a runner that reached for the pool itself would be a domain
 * file reaching into the database outside a repository, which is the one thing
 * the audit is there to prevent.
 */
export function createRetentionRunner(
    store: RetentionStore,
    minimumIntervalMs: number = 24 * 3_600_000,
): RetentionRunner {
    let lastRunAt: number | null = null;

    return {
        async maybeRun(now: number) {
            if (lastRunAt !== null && now - lastRunAt < minimumIntervalMs) {
                return { skipped: true, report: null };
            }

            const report = await store.prune(now);

            // Set after the prune, not before: a run that throws has not happened,
            // and recording it as though it had would suppress the next attempt for
            // a day after a failure nobody was told about.
            lastRunAt = now;

            return { skipped: false, report };
        },
    };
}
